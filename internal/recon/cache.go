package recon

import (
	"crypto/sha256"
	"sync"
	"time"
)

type cache struct {
	now func() time.Time

	mu      sync.RWMutex
	entries map[entryKey]Result
}

type entryKey struct {
	fingerprint scriptFingerprint
	issueKey    string
}

type scriptFingerprint [sha256.Size]byte

func newCache() *cache {
	return &cache{entries: map[entryKey]Result{}}
}

func (c *cache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func newScriptFingerprint(source string) scriptFingerprint {
	return sha256.Sum256([]byte(source))
}

func (c *cache) lookup(fingerprint scriptFingerprint, keys []string) map[string]Result {
	entries := make(map[string]Result, len(keys))
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, key := range keys {
		entry, ok := c.entries[entryKey{fingerprint: fingerprint, issueKey: key}]
		if !ok {
			continue
		}
		entries[key] = entry
	}
	return entries
}

func (c *cache) store(fingerprint scriptFingerprint, results []Result) {
	now := c.clock()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, result := range results {
		result.CheckedAt = now
		key := entryKey{fingerprint: fingerprint, issueKey: result.Key}
		c.entries[key] = result
	}
}
