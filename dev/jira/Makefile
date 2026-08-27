# A tiny Jira Data Center stand-in for local Roadie development.

ADDR ?= localhost:4012
ISSUES ?= issues.json
# Delay `key in (...)` searches, the form the schedule check uses: DELAY=5s.
DELAY ?= 0

.PHONY: run test

run:
	go run . -addr=$(ADDR) -issues=$(ISSUES) -key-search-delay=$(DELAY)

test:
	go test .
