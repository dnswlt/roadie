package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// keyLen is the session key size: AES-256 needs 32 bytes.
const keyLen = 32

// errExpired distinguishes a well-formed but stale token from a corrupt or
// forged one, so the caller can treat "log in again" differently from "someone
// is poking at us".
var errExpired = errors.New("expired")

// NewSessionKey returns a fresh random session key, for a deployment that has
// not configured one. Sessions sealed with it die with the process, so it is a
// dev convenience only — see the SESSION_KEY handling in cmd/roadie.
func NewSessionKey() []byte {
	k := make([]byte, keyLen)
	if _, err := rand.Read(k); err != nil {
		panic(fmt.Sprintf("auth: generating session key: %v", err))
	}
	return k
}

// sealer encrypts small JSON payloads into cookie-safe strings.
//
// AES-GCM (rather than a plain HMAC signature) buys confidentiality on top of
// integrity: the session carries a name and an email address, and there is no
// reason to leave those readable in devtools or in a proxy's cookie log. The
// nonce is random per seal and prepended to the ciphertext.
type sealer struct{ aead cipher.AEAD }

func newSealer(key []byte) (*sealer, error) {
	if len(key) != keyLen {
		return nil, fmt.Errorf("session key must be %d bytes, got %d", keyLen, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead: aead}, nil
}

func (s *sealer) seal(v any) (string, error) {
	plain, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	// Seal appends to its first argument, so passing the nonce lays the result
	// out as nonce||ciphertext in one allocation.
	return base64.RawURLEncoding.EncodeToString(s.aead.Seal(nonce, nonce, plain, nil)), nil
}

// open decrypts a token into v. It does not check expiry — the payload types
// own that, since they carry differently-shaped deadlines.
func (s *sealer) open(tok string, v any) error {
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		return fmt.Errorf("malformed token")
	}
	n := s.aead.NonceSize()
	if len(raw) < n {
		return fmt.Errorf("malformed token")
	}
	plain, err := s.aead.Open(nil, raw[:n], raw[n:], nil)
	if err != nil {
		return fmt.Errorf("token failed authentication")
	}
	return json.Unmarshal(plain, v)
}

// session is what a logged-in browser carries: the claims Roadie actually uses,
// plus an absolute deadline. Deliberately no access or refresh token — Roadie
// calls no downstream API, so once login has told us who the user is there is
// nothing left to keep.
type session struct {
	Subject string `json:"sub"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Expires int64  `json:"exp"` // unix seconds
}

func (a *Authenticator) sealSession(id Identity) (string, error) {
	return a.sealer.seal(session{
		Subject: id.Subject,
		Name:    id.Name,
		Email:   id.Email,
		Expires: time.Now().Add(a.sessionTTL).Unix(),
	})
}

func (a *Authenticator) openSession(tok string) (Identity, error) {
	var s session
	if err := a.sealer.open(tok, &s); err != nil {
		return Identity{}, err
	}
	if time.Now().Unix() >= s.Expires {
		return Identity{}, errExpired
	}
	if s.Subject == "" {
		// An anonymous identity must never come out of a session: downstream
		// code reads a blank subject as "no auth", which would be a bypass.
		return Identity{}, fmt.Errorf("session without subject")
	}
	return Identity{Subject: s.Subject, Name: s.Name, Email: s.Email}, nil
}

// loginState is the leg of the flow that has to survive the round trip to the
// provider. Keeping it in a short-lived cookie rather than a server-side map is
// what lets several replicas share the login flow without a shared store.
//
// State is both stored here and sent as the OAuth state parameter; comparing
// the two on return is what stops an attacker from feeding us their own
// authorization code (login CSRF).
type loginState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Next     string `json:"r"`
	Expires  int64  `json:"exp"`
}

// randomToken returns an unguessable URL-safe string for state and nonce.
func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("auth: reading random: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
