# A tiny Jira Data Center stand-in for local Roadie development.

ADDR ?= localhost:4012
ISSUES ?= issues.json

.PHONY: run test

run:
	go run . -addr=$(ADDR) -issues=$(ISSUES)

test:
	go test .
