// Package extractor compiles and runs a roadmap's tracker extractor script:
// the Starlark that says which tracker fields carry an issue's schedule and
// how to read a date range out of them. It knows no HTTP and no database.
//
// The script's input is deliberately provider-shaped — it reads
// customfield_10020 — so raw issue JSON reaches this package and stops here.
// What leaves is neutral: two dates and a label saying where they came from.
//
// A script is hermetic — no load(), no I/O, no clock, no recursion and no
// while, which is why FileOptions stays zero-valued rather than borrowing the
// resolver's legacy globals — but it is not resource-bounded. It runs in the
// server process and spends what it likes: `for i in range(1000000000000)`
// runs for hours, and `[0] * 1000000000` asks for ~17GB and kills the process.
// Saving a script is therefore a trusted action, unlike posting JQL.
//
// No step budget and no deadline. Neither bounds that allocation, which happens
// inside one step where nothing is checked, so both only make this read like a
// sandbox. A real boundary means running the script outside this process; do
// not add a budget to stand in for one.
package extractor

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.starlark.net/starlark"
	"go.starlark.net/syntax"
)

// The script's well-known names. A script is free to define anything else; only
// these two are read.
const (
	// TimeRangeFunc is the first well-known entry point, not the only
	// conceivable one — which is why nothing here is named after it.
	TimeRangeFunc = "get_issue_time_range"
	// FieldsVar names tracker field ids, passed to the tracker untouched.
	FieldsVar = "JIRA_FIELDS"
)

// scriptFile is the filename in every message a script produces, so a compile
// error and a runtime error read the same way.
const scriptFile = "extractor.star"

// fileOptions is plain Starlark: every dialect extension off. See the package
// comment for why that is the sandbox.
var fileOptions = &syntax.FileOptions{}

// Result is one issue's extraction outcome.
//
// Skip and "no dates" are the same answer, so the script's two uses — filtering
// (a closed issue, another team's project) and the blank (no fix version set
// yet) — collapse into one state: there is nothing to compare.
type Result struct {
	Start string `json:"start,omitempty"`
	End   string `json:"end,omitempty"`
	// Label is provenance, e.g. "Sprint 24". Only the script can supply it:
	// Roadie sees two dates and cannot know which field they were read from.
	Label string `json:"label,omitempty"`
	Skip  bool   `json:"skip,omitempty"`
	// Output is what this run printed, for the editor's Test panel — a user
	// debugging a script shouldn't need shell access to the server log.
	Output []string `json:"output,omitempty"`
}

// Script is a compiled extractor, ready to run against issues. Compiling is
// cheap next to a single tracker round-trip, so callers compile per request
// rather than caching.
type Script struct {
	fields []string
	fn     starlark.Callable
	output []string
}

// Compile parses the source, executes its top level, and checks the well-known
// names. Every failure it reports is the script author's to fix — there is no
// internal-error path — which is what lets the server answer 400 for all of
// them.
func Compile(src string) (*Script, error) {
	s := &Script{}
	globals, err := starlark.ExecFileOptions(fileOptions, newThread(&s.output), scriptFile, src, nil)
	if err != nil {
		return nil, scriptError(err)
	}

	fn, ok := globals[TimeRangeFunc]
	if !ok {
		return nil, fmt.Errorf("script defines no %s(issue) function", TimeRangeFunc)
	}
	callable, ok := fn.(starlark.Callable)
	if !ok {
		return nil, fmt.Errorf("%s is %s, not a function", TimeRangeFunc, fn.Type())
	}
	s.fn = callable

	if fields, ok := globals[FieldsVar]; ok {
		s.fields, err = decodeFields(fields)
		if err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Fields is what the script declared in JIRA_FIELDS, in source order, or nil.
// The caller decides what to add to it; the display fields it always fetches
// are none of this package's business.
func (s *Script) Fields() []string { return s.fields }

// Output is what the top level printed while compiling.
func (s *Script) Output() []string { return s.output }

// TimeRange runs the entry point for one issue. issue is the tracker's decoded
// JSON, nested as the tracker returns it.
//
// An error is per issue: one raising issue gets an error state and the rest
// still run. Whatever the call printed before failing comes back with it.
func (s *Script) TimeRange(issue map[string]any) (Result, error) {
	arg, err := toStarlark(issue)
	if err != nil {
		return Result{}, err
	}
	var output []string
	v, err := starlark.Call(newThread(&output), s.fn, starlark.Tuple{arg}, nil)
	if err != nil {
		return Result{Output: output}, scriptError(err)
	}
	res, err := decodeResult(v)
	res.Output = output
	return res, err
}

// newThread builds the thread one run gets. print() goes to sink rather than
// the server log: a user debugging a script has no shell access.
func newThread(sink *[]string) *starlark.Thread {
	return &starlark.Thread{
		Name:  "extractor",
		Print: func(_ *starlark.Thread, msg string) { *sink = append(*sink, msg) },
	}
}

// decodeFields checks JIRA_FIELDS is a list of non-empty strings. The ids go to
// the tracker untouched, so a typo here is a query the tracker rejects, far
// from the line that caused it.
func decodeFields(v starlark.Value) ([]string, error) {
	list, ok := v.(*starlark.List)
	if !ok {
		return nil, fmt.Errorf("%s is %s, not a list of field ids", FieldsVar, v.Type())
	}
	fields := make([]string, 0, list.Len())
	for i := range list.Len() {
		s, ok := starlark.AsString(list.Index(i))
		if !ok {
			return nil, fmt.Errorf("%s[%d] is %s, not a field id", FieldsVar, i, list.Index(i).Type())
		}
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("%s[%d] is empty", FieldsVar, i)
		}
		fields = append(fields, s)
	}
	return fields, nil
}

// resultKeys is closed on purpose: "lable" or "ends" silently ignored would
// cost an afternoon, so an unrecognized key is an error.
var resultKeys = map[string]bool{"start": true, "end": true, "label": true}

func decodeResult(v starlark.Value) (Result, error) {
	if v == starlark.None {
		return Result{Skip: true}, nil
	}
	dict, ok := v.(*starlark.Dict)
	if !ok {
		return Result{}, fmt.Errorf("%s returned %s, want a dict or None", TimeRangeFunc, v.Type())
	}
	var res Result
	for _, item := range dict.Items() {
		key, ok := starlark.AsString(item[0])
		if !ok {
			return Result{}, fmt.Errorf("%s returned a %s key, want one of start, end, label", TimeRangeFunc, item[0].Type())
		}
		if !resultKeys[key] {
			return Result{}, fmt.Errorf("%s returned unknown key %q, want one of start, end, label", TimeRangeFunc, key)
		}
		val := item[1]
		if val == starlark.None {
			continue
		}
		str, ok := starlark.AsString(val)
		if !ok {
			return Result{}, fmt.Errorf("%s: %s is %s, want a string or None", TimeRangeFunc, key, val.Type())
		}
		switch key {
		case "label":
			res.Label = str
		default:
			day, err := normalizeDate(str)
			if err != nil {
				return Result{}, fmt.Errorf("%s: %s %w", TimeRangeFunc, key, err)
			}
			if key == "start" {
				res.Start = day
			} else {
				res.End = day
			}
		}
	}
	// A dict naming no date says what None says.
	if res.Start == "" && res.End == "" {
		return Result{Skip: true}, nil
	}
	return res, nil
}

// timestampLayouts are the ISO forms a tracker returns, once the date/time
// separator has been normalized to 'T': Jira Data Center writes the zone as
// +0200, Jira Cloud as +02:00, and a field can carry no zone at all.
var timestampLayouts = []string{
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05.999999999",
}

// normalizeDate takes YYYY-MM-DD, or an ISO timestamp it truncates *as
// written*: the whole value has to parse, so trailing garbage is an error, but
// what comes back is the written prefix and never the parsed instant.
// Converting the zone instead would move a date by a day for reasons nobody
// could explain from the roadmap.
func normalizeDate(s string) (string, error) {
	if len(s) == len(time.DateOnly) {
		if _, err := time.Parse(time.DateOnly, s); err != nil {
			return "", notADate(s)
		}
		return s, nil
	}
	if len(s) > len(time.DateOnly) {
		day, sep, rest := s[:len(time.DateOnly)], s[len(time.DateOnly)], s[len(time.DateOnly)+1:]
		if sep == 'T' || sep == ' ' {
			for _, layout := range timestampLayouts {
				if _, err := time.Parse(layout, day+"T"+rest); err == nil {
					return day, nil
				}
			}
		}
	}
	return "", notADate(s)
}

func notADate(s string) error { return fmt.Errorf("is not a date: %q", s) }

// scriptError renders a Starlark failure as message plus the line it happened
// on: EvalError.Error() is the message alone and Backtrace() a whole stack,
// where an editor wants the one line to jump to. Compile errors already carry
// their position and pass through.
//
// The innermost frame is a builtin whenever the script called one — fail(), a
// bad dict lookup — and "<builtin>:1" is no line to jump to, so the search
// descends to the innermost frame actually in the script.
func scriptError(err error) error {
	var evalErr *starlark.EvalError
	if !errors.As(err, &evalErr) {
		return err
	}
	for i := len(evalErr.CallStack) - 1; i >= 0; i-- {
		if pos := evalErr.CallStack[i].Pos; pos.Filename() == scriptFile {
			return fmt.Errorf("%s: %s", pos, evalErr.Msg)
		}
	}
	return err
}

// toStarlark converts decoded JSON into the plain dict a script reads. Numbers
// arrive as json.Number when the caller decoded with UseNumber, and as float64
// otherwise; both are real inputs.
func toStarlark(v any) (starlark.Value, error) {
	switch v := v.(type) {
	case nil:
		return starlark.None, nil
	case bool:
		return starlark.Bool(v), nil
	case string:
		return starlark.String(v), nil
	case float64:
		return starlark.Float(v), nil
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return starlark.MakeInt64(i), nil
		}
		f, err := v.Float64()
		if err != nil {
			return nil, fmt.Errorf("cannot convert number %s", v)
		}
		return starlark.Float(f), nil
	case []any:
		elems := make([]starlark.Value, 0, len(v))
		for _, e := range v {
			sv, err := toStarlark(e)
			if err != nil {
				return nil, err
			}
			elems = append(elems, sv)
		}
		return starlark.NewList(elems), nil
	case map[string]any:
		dict := starlark.NewDict(len(v))
		for k, e := range v {
			sv, err := toStarlark(e)
			if err != nil {
				return nil, err
			}
			if err := dict.SetKey(starlark.String(k), sv); err != nil {
				return nil, err
			}
		}
		return dict, nil
	default:
		return nil, fmt.Errorf("cannot convert %T to a Starlark value", v)
	}
}
