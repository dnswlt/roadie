# Local Jira Data Center mock

A small read-only server for developing Jira Recon without a real Jira
installation. It reads [`issues.json`](issues.json) at startup and exposes only
the Jira Data Center endpoints Roadie needs:

- `POST /rest/api/2/search`
- `GET /rest/api/2/issue/{issueIdOrKey}`

For useful local interaction without implementing JQL, the mock treats the
`jql` value as a title search: it splits the value on whitespace and returns
issues whose summaries contain every term, case-insensitively. An empty value
returns all issues. Search paging through `startAt` and `maxResults` is
supported and applies after filtering.

The one real JQL form it implements is `key in ("A", "B")`, the by-key fetch
behind the schedule check. As Jira does, it rejects the **whole** query with a
400 when any key is unknown — that rejection is what makes Roadie fall back to
one request per key, and this is the only way to exercise that path locally.

Field selection is honoured, so a script cannot read a field nobody asked Jira
for and discover it only in production. Beyond `summary`, `issuetype` and
`status`, an issue may carry a `fields` object in the fixture holding extra
Jira fields spelled and nested exactly as Jira spells them:

```json
{
  "key": "PAY-101", "summary": "…", "issueType": "Epic", "status": "In Progress",
  "fields": {
    "duedate": "2026-04-12T00:00:00.000+0200",
    "fixVersions": [{ "name": "26.2", "releaseDate": "2026-03-31" }]
  }
}
```

```sh
make -C dev/jira run
```

The server listens on <http://localhost:4012>. Edit `issues.json` and restart it
to change the fixture.

Example search:

```sh
curl -s http://localhost:4012/rest/api/2/search \
  -H 'Content-Type: application/json' \
  -d '{"jql":"payment provider","startAt":0,"maxResults":2,"fields":["summary","issuetype","status"]}'
```
