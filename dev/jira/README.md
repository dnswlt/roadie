# Local Jira Data Center mock

A small read-only server for developing Jira Recon without a real Jira
installation. It reads [`issues.json`](issues.json) at startup and exposes only
the Jira Data Center endpoints Roadie needs:

- `POST /rest/api/2/search`
- `GET /rest/api/2/issue/{issueIdOrKey}`

JQL and requested fields are accepted but ignored. Search paging through
`startAt` and `maxResults` is supported.

```sh
make -C dev/jira run
```

The server listens on <http://localhost:4012>. Edit `issues.json` and restart it
to change the fixture.

Example search:

```sh
curl -s http://localhost:4012/rest/api/2/search \
  -H 'Content-Type: application/json' \
  -d '{"jql":"project = PAY","startAt":0,"maxResults":2,"fields":["summary","issuetype","status"]}'
```
