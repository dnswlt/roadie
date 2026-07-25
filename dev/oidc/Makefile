# Starts and stops the throwaway identity provider. That is all it does —
# running Roadie against it is the root Makefile's `dev-oidc` rule.
#
#   make -C dev/oidc up
#   make -C dev/oidc down

# Same convention as the root Makefile: on macOS (Homebrew/Colima) the dashed
# binary is the one that works; elsewhere use the compose plugin.
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
    DC_CMD := docker-compose
else
    DC_CMD := docker compose
endif

ISSUER ?= http://localhost:4011

.PHONY: up down logs

# The image has no healthcheck and takes a few seconds to answer, so wait for
# discovery rather than letting the first login fail confusingly.
up:
	$(DC_CMD) up -d
	@printf 'waiting for the OIDC provider'; \
	for i in $$(seq 30); do \
		if curl -s --max-time 2 -o /dev/null $(ISSUER)/.well-known/openid-configuration; then \
			echo " ready at $(ISSUER)"; exit 0; \
		fi; \
		printf '.'; sleep 1; \
	done; \
	echo; echo "timed out; check 'make -C dev/oidc logs'"; exit 1

down:
	$(DC_CMD) down

logs:
	$(DC_CMD) logs --tail=50
