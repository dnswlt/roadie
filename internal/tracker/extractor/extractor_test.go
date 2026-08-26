package extractor

import (
	"encoding/json"
	"strings"
	"testing"
)

// fixVersions is the script the spec opens with: the shape a real deployment
// starts from.
const fixVersions = `
JIRA_FIELDS = ["fixVersions", "customfield_10020"]

def get_issue_time_range(issue):
    if issue["fields"]["status"]["name"] == "Done":
        return None
    versions = issue["fields"].get("fixVersions") or []
    if not versions:
        return None
    v = versions[0]
    return {"start": None, "end": v.get("releaseDate"), "label": v.get("name")}
`

// issue decodes JSON the way the fetch path will, numbers included.
func issue(t *testing.T, src string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(src))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

func compile(t *testing.T, src string) *Script {
	t.Helper()
	s, err := Compile(src)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return s
}

func TestFixVersionScript(t *testing.T) {
	s := compile(t, fixVersions)
	if got := s.Fields(); len(got) != 2 || got[0] != "fixVersions" || got[1] != "customfield_10020" {
		t.Fatalf("Fields() = %v", got)
	}

	res, err := s.TimeRange(issue(t, `{
		"key": "PAY-1",
		"fields": {
			"status": {"name": "In Progress"},
			"fixVersions": [{"name": "26.3", "releaseDate": "2026-04-12"}]
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if res.Skip || res.Start != "" || res.End != "2026-04-12" || res.Label != "26.3" {
		t.Fatalf("result = %+v", res)
	}

	// A filtered issue and a blank one are the same state.
	for name, src := range map[string]string{
		"closed":         `{"fields": {"status": {"name": "Done"}, "fixVersions": [{"releaseDate": "2026-04-12"}]}}`,
		"no fix version": `{"fields": {"status": {"name": "To Do"}, "fixVersions": []}}`,
	} {
		res, err := s.TimeRange(issue(t, src))
		if err != nil || !res.Skip {
			t.Fatalf("%s: result = %+v, err = %v", name, res, err)
		}
	}
}

// A dict naming no date says what None says: nothing to compare.
func TestLabelWithoutDatesSkips(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    return {"label": "Sprint 24"}
`)
	res, err := s.TimeRange(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Skip || res.Label != "" {
		t.Fatalf("result = %+v", res)
	}
}

func TestSchedulePeriodReferences(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    return {"startPeriod": "PI2026-09", "endPeriod": "PI2026-10", "label": "PI labels"}
`)
	res, err := s.TimeRange(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Skip || res.StartPeriod != "PI2026-09" || res.EndPeriod != "PI2026-10" || res.Label != "PI labels" {
		t.Fatalf("result = %+v", res)
	}
}

func TestOneBoundaryHasOneSource(t *testing.T) {
	for name, result := range map[string]string{
		"start": `{"start": "2026-09-01", "startPeriod": "PI2026-09"}`,
		"end":   `{"end": "2026-09-30", "endPeriod": "PI2026-09"}`,
	} {
		s := compile(t, "def get_issue_time_range(issue):\n    return "+result+"\n")
		if _, err := s.TimeRange(map[string]any{}); err == nil || !strings.Contains(err.Error(), "both "+name) {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
}

func TestDates(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    return {"start": issue["s"], "end": issue["e"]}
`)
	// An ISO timestamp is truncated as written: the +0200 must not move the day.
	res, err := s.TimeRange(map[string]any{
		"s": "2026-04-12T23:30:00.000+0200",
		"e": "2026-05-01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Start != "2026-04-12" || res.End != "2026-05-01" {
		t.Fatalf("result = %+v", res)
	}

	// Every real tracker spelling of a timestamp truncates to its written day.
	for _, ok := range []string{
		"2026-04-12T23:30:00.000+0200",  // Jira Data Center
		"2026-04-12T23:30:00.000+02:00", // Jira Cloud
		"2026-04-12T23:30:00Z",
		"2026-04-12T23:30:00",
		"2026-04-12 23:30:00",
	} {
		res, err := s.TimeRange(map[string]any{"s": ok, "e": nil})
		if err != nil || res.Start != "2026-04-12" {
			t.Fatalf("%q: start = %q, err = %v", ok, res.Start, err)
		}
	}

	// A prefix that looks like a date does not excuse the rest: the whole
	// value has to parse, or it names itself in an extraction error.
	for _, bad := range []string{
		"12/04/2026", "2026-13-01", "2026-04-12X", "next Tuesday", "",
		"2026-04-12Tgarbage", "2026-04-12  ", "2026-04-12T", "2026-04-12T25:00:00",
		"2026-04-12T23:30:00.000+0200 and then some",
	} {
		if _, err := s.TimeRange(map[string]any{"s": bad, "e": nil}); err == nil {
			t.Fatalf("%q: want an extraction error", bad)
		} else if !strings.Contains(err.Error(), bad) {
			t.Fatalf("%q: error does not name the value: %v", bad, err)
		}
	}
}

// A misspelled key must not read as "no dates".
func TestUnknownKeyIsAnError(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    return {"end": "2026-04-12", "lable": "Sprint 24"}
`)
	_, err := s.TimeRange(map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "lable") {
		t.Fatalf("err = %v", err)
	}
}

func TestBadReturnValues(t *testing.T) {
	for name, body := range map[string]string{
		"not a dict":       `return "2026-04-12"`,
		"date is int":      `return {"end": 20260412}`,
		"period is a list": `return {"endPeriod": ["PI2026-09"]}`,
		"label is a list":  `return {"end": "2026-04-12", "label": ["a"]}`,
	} {
		s := compile(t, "def get_issue_time_range(issue):\n    "+body+"\n")
		if _, err := s.TimeRange(map[string]any{}); err == nil {
			t.Fatalf("%s: want an error", name)
		}
	}
}

func TestCompileRejects(t *testing.T) {
	cases := map[string]string{
		"syntax error":         `def get_issue_time_range(issue)`,
		"top level raises":     "x = 1 // 0\ndef get_issue_time_range(issue):\n    return None\n",
		"no entry point":       `JIRA_FIELDS = ["duedate"]`,
		"entry point is data":  `get_issue_time_range = 42`,
		"fields not a list":    "JIRA_FIELDS = \"duedate\"\ndef get_issue_time_range(issue):\n    return None\n",
		"field not a string":   "JIRA_FIELDS = [1]\ndef get_issue_time_range(issue):\n    return None\n",
		"field is empty":       "JIRA_FIELDS = [\" \"]\ndef get_issue_time_range(issue):\n    return None\n",
		"load is unavailable":  "load(\"other.star\", \"f\")\ndef get_issue_time_range(issue):\n    return None\n",
		"while is unavailable": "def get_issue_time_range(issue):\n    while True:\n        pass\n",
	}
	for name, src := range cases {
		if _, err := Compile(src); err == nil {
			t.Fatalf("%s: want a compile error", name)
		}
	}
	// JIRA_FIELDS is optional; the entry point is not.
	compile(t, "def get_issue_time_range(issue):\n    return None\n")
}

// Recursion is rejected when the second call happens, not when the script is
// saved — so it is a per-issue error like any other, not a save-time one.
// Nothing else bounds a run: see the package comment.
func TestRecursionIsRejected(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    return get_issue_time_range(issue)
`)
	if _, err := s.TimeRange(map[string]any{}); err == nil {
		t.Fatal("want recursion to be rejected")
	}
}

func TestPrintIsCaptured(t *testing.T) {
	s := compile(t, `
print("top level")

def get_issue_time_range(issue):
    print("key", issue["key"])
    return None
`)
	if got := s.Output(); len(got) != 1 || got[0] != "top level" {
		t.Fatalf("Output() = %v", got)
	}
	res, err := s.TimeRange(map[string]any{"key": "PAY-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Output) != 1 || res.Output[0] != "key PAY-1" {
		t.Fatalf("Output = %v", res.Output)
	}
}

// A raising issue must report what it printed on the way, or debugging the
// script means guessing.
func TestOutputSurvivesAFailure(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    print("before")
    fail("boom")
`)
	res, err := s.TimeRange(map[string]any{})
	if err == nil {
		t.Fatal("want an error")
	}
	if len(res.Output) != 1 || res.Output[0] != "before" {
		t.Fatalf("Output = %v", res.Output)
	}
	// The message names the line to jump to, not a whole backtrace.
	if !strings.Contains(err.Error(), scriptFile+":4") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
}

// Jira nests arrays, objects, numbers and nulls; a script reads all of them.
func TestIssueConversion(t *testing.T) {
	s := compile(t, `
def get_issue_time_range(issue):
    f = issue["fields"]
    print(type(f["votes"]), f["votes"], f["progress"], f["resolution"], f["labels"][1], f["flagged"])
    return None
`)
	res, err := s.TimeRange(issue(t, `{"fields": {
		"votes": 3,
		"progress": 0.25,
		"resolution": null,
		"labels": ["a", "b"],
		"flagged": true
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(res.Output, "|"); got != "int 3 0.25 None b True" {
		t.Fatalf("Output = %q", got)
	}
}
