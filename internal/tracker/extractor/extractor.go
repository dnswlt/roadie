// Package extractor compiles and runs tracker schedule scripts.
//
// Scripts are hermetic but not resource-bounded and run in the server process.
// Saving script source is a trusted operation.
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

const (
	// TimeRangeFunc is the extractor entry point.
	TimeRangeFunc = "get_issue_time_range"
	// FieldsVar names the tracker fields required by the script.
	FieldsVar = "JIRA_FIELDS"
)

const scriptFile = "extractor.star"

var fileOptions = &syntax.FileOptions{}

// Result is one issue's extraction outcome.
type Result struct {
	Start  string   `json:"start,omitempty"`
	End    string   `json:"end,omitempty"`
	Label  string   `json:"label,omitempty"`
	Skip   bool     `json:"skip,omitempty"`
	Output []string `json:"output,omitempty"`
}

// Script is a compiled extractor.
type Script struct {
	fields []string
	fn     starlark.Callable
	output []string
}

// Compile parses the source, executes its top level, and validates its entry
// point and field list.
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

// Fields returns JIRA_FIELDS in source order.
func (s *Script) Fields() []string { return s.fields }

// Output is what the top level printed while compiling.
func (s *Script) Output() []string { return s.output }

// TimeRange runs the extractor for one decoded tracker issue.
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

func newThread(sink *[]string) *starlark.Thread {
	return &starlark.Thread{
		Name:  "extractor",
		Print: func(_ *starlark.Thread, msg string) { *sink = append(*sink, msg) },
	}
}

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
		switch key {
		case "start", "end", "label":
		default:
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
	if res.Start == "" && res.End == "" {
		return Result{Skip: true}, nil
	}
	return res, nil
}

var timestampLayouts = []string{
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05.999999999",
}

// normalizeDate preserves the written date of a valid date or ISO timestamp.
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

// scriptError adds the innermost script position to runtime errors.
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

// toStarlark converts decoded JSON values into Starlark values.
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
