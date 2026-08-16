# Local Jira Data Center mock

A small read-only server for developing Jira Recon without a real Jira
installation. It reads [`issues.json`](issues.json) at startup and exposes only
the Jira Data Center endpoints Roadie needs:

- `POST /rest/api/2/search`
- `GET /rest/api/2/issue/{issueIdOrKey}`

For useful local interaction without implementing JQL, the mock treats the
`jql` value as a title search: it splits the value on whitespace and returns
issues whose summaries contain every term, case-insensitively. An empty value
returns all issues. Requested fields are ignored. Search paging through
`startAt` and `maxResults` is supported and applies after filtering.

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
