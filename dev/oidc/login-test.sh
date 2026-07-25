#!/usr/bin/env bash
#
# End-to-end check of Roadie's OIDC login against the provider in this
# directory. Walks the whole authorization code flow the way a browser would:
#
#   Roadie /auth/login -> provider /connect/authorize -> its HTML login form
#   (antiforgery token and all) -> Roadie's callback -> a session cookie
#
# then confirms the session identifies the user to the API, that mutations work
# and that CSRF and logout behave. Nothing else covers this: the Go tests cannot
# do a real OIDC round trip.
#
# IMPORTANT: passing here does NOT mean a browser can log in. curl implements
# neither SameSite nor Secure, so a provider whose session cookie a browser
# would reject still sails through this script. That exact bug shipped once.
# Browser behaviour has to be checked in a browser.
#
# Usage:  ./login-test.sh [username]     (default: the first user in users.json)
#
#   make -C dev/oidc up     # provider
#   make dev-oidc           # Roadie, in another shell
#   dev/oidc/login-test.sh
set -uo pipefail

cd "$(dirname "$0")" || exit 1

ISSUER="${ISSUER:-http://localhost:4011}"
ROADIE="${ROADIE:-http://localhost:8080}"

fail() { echo "FAIL: $*" >&2; exit 1; }

# Credentials and expected claims come from users.json rather than being
# repeated here, so editing that file cannot leave this script asserting
# something stale.
# Tab-separated, since display names contain spaces.
IFS=$'\t' read -r USER_NAME PASSWORD EXPECT_NAME EXPECT_EMAIL < <(
  python3 - "${1:-}" <<'PY'
import json, sys
want = sys.argv[1]
users = json.load(open("users.json"))
user = next((u for u in users if u["Username"] == want), None) if want else users[0]
if user is None:
    sys.exit(f"no user {want!r} in users.json")
claims = {c["Type"]: c["Value"] for c in user["Claims"]}
email = claims.get("email", claims.get("preferred_username", claims.get("upn", "")))
print("\t".join([user["Username"], user["Password"], claims.get("name", email), email]))
PY
) || exit 1

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
# One cookie jar for both hosts: cookies ignore ports, so Roadie and the
# provider share it on localhost, exactly as they do in a browser.
CURL=(curl -s -c "$JAR" -b "$JAR")

curl -s -m 3 -o /dev/null "$ROADIE/healthz" || fail "Roadie is not answering at $ROADIE (make dev-oidc)"
curl -s -m 3 -o /dev/null "$ISSUER/.well-known/openid-configuration" \
  || fail "no OIDC provider at $ISSUER (make -C dev/oidc up)"

echo "== 1. start the flow at Roadie =="
authorize_url=$("${CURL[@]}" -o /dev/null -w '%{redirect_url}' "$ROADIE/auth/login?next=%2F%3Fdeep%3Dlink")
[[ "$authorize_url" == "$ISSUER"/connect/authorize* ]] \
  || fail "expected a redirect to the provider, got: $authorize_url"
echo "   -> authorize endpoint, $(grep -o 'code_challenge_method=[^&]*' <<<"$authorize_url")"

echo "== 2. follow to the provider's login form =="
login_page=$("${CURL[@]}" -L "$authorize_url")
# IdentityServer guards the form with an antiforgery token tied to a cookie.
token=$(grep -o 'name="__RequestVerificationToken"[^>]*value="[^"]*"' <<<"$login_page" \
        | sed 's/.*value="//; s/"$//' | head -1)
return_url=$(grep -o 'name="ReturnUrl"[^>]*value="[^"]*"' <<<"$login_page" \
        | sed 's/.*value="//; s/"$//' | head -1)
[[ -n "$token" ]] || fail "no antiforgery token in the login page"
# The form carries HTML-escaped values; unescape before posting them back.
return_url=$(python3 -c 'import html,sys; print(html.unescape(sys.argv[1]))' "$return_url")
echo "   -> antiforgery token obtained"

echo "== 3. submit credentials as $USER_NAME =="
"${CURL[@]}" -o /dev/null -X POST "$ISSUER/Account/Login" \
  --data-urlencode "Username=$USER_NAME" \
  --data-urlencode "Password=$PASSWORD" \
  --data-urlencode "ReturnUrl=$return_url" \
  --data-urlencode "__RequestVerificationToken=$token" \
  --data-urlencode "button=login"

echo "== 4. resume authorize, follow the chain back to Roadie =="
# --max-redirs stops a misconfigured loop from spinning; the callback ends the
# chain by redirecting to `next`.
final=$("${CURL[@]}" -L --max-redirs 10 -o /dev/null -w '%{url_effective}' "$ISSUER$return_url")
echo "   -> landed on: $final"
case "$final" in
  *Account/Login*) fail "looped back to the login form — the session cookie was not accepted" ;;
  "$ROADIE"*) ;;
  *) fail "flow did not return to Roadie: $final" ;;
esac

echo "== 5. session cookie =="
grep -q roadie_session "$JAR" || fail "no roadie_session cookie was set"
echo "   -> roadie_session present"

echo "== 6. who does the API think we are? =="
me=$("${CURL[@]}" "$ROADIE/api/me")
echo "   -> $me"
grep -q '"authenticated":true' <<<"$me" || fail "/api/me reports no authenticated session"
# The point of the feature: a change must be attributable to a person, not to an
# opaque subject id. This is what catches claims arriving only via UserInfo.
grep -q "\"name\":\"$EXPECT_NAME\"" <<<"$me" || fail "expected name \"$EXPECT_NAME\""
grep -q "\"email\":\"$EXPECT_EMAIL\"" <<<"$me" || fail "expected email \"$EXPECT_EMAIL\""

echo "== 7. an authenticated mutation =="
created=$("${CURL[@]}" -X POST "$ROADIE/api/roadmaps" \
  -H 'Content-Type: application/json' -H 'X-Client-Id: login-test' \
  -d "{\"name\":\"login-test-$USER_NAME\"}")
rm_id=$(grep -o '"id":[0-9]*' <<<"$created" | head -1 | cut -d: -f2)
[[ "$rm_id" =~ ^[0-9]+$ ]] || fail "could not create a roadmap: $created"
echo "   -> created roadmap $rm_id"

echo "== 8. the same mutation without the CSRF header must be refused =="
csrf=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$ROADIE/api/roadmaps" \
  -H 'Content-Type: application/json' -d '{"name":"csrf-should-fail"}')
echo "   -> without X-Client-Id: $csrf"
[[ "$csrf" == "403" ]] || fail "expected 403 without X-Client-Id, got $csrf"

echo "== 9. clean up =="
"${CURL[@]}" -o /dev/null -X DELETE -H 'X-Client-Id: login-test' "$ROADIE/api/roadmaps/$rm_id"
echo "   -> deleted roadmap $rm_id"

echo "== 10. sign out drops the session =="
"${CURL[@]}" -o /dev/null -X POST -H 'X-Client-Id: login-test' "$ROADIE/auth/logout"
after=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$ROADIE/api/me")
echo "   -> /api/me after logout: $after"
[[ "$after" == "401" ]] || fail "still authenticated after logout ($after)"

echo
echo "PASS: login flow works for $USER_NAME ($EXPECT_NAME)"
