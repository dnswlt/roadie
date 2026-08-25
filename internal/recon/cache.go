// Package recon backs Jira Recon's schedule check: are the issues linked from a
// roadmap item still scheduled inside that item's range?
//
// Jira is reached by exactly one goroutine, process-wide (see Fetcher). Clients
// feed it keys and poll for results; a poll is a pure read of the cache and can
// never cause a fetch, however often it is made. Keys nothing has established
// yet read as StateUnchecked.
//
// The package knows no HTTP and no database: it is handed a tracker client and
// a function that returns a roadmap's script.
package recon

import (
	"crypto/sha256"
	"strings"
	"sync"
	"time"
)

// DefaultFreshness is how long a checked issue is reused. It is a debounce
// rather than a correctness window: the fetcher skips a key this recently
// established, so re-running a check costs the tracker nothing. Long enough to
// cover repeat runs, short enough that a schedule edited in Jira shows up on
// the next check a minute later.
const DefaultFreshness = time.Minute

// Cache holds issue results established by the fetcher. The fetcher is its only
// writer; a poll only reads.
//
// Entries hold the extracted result, never the raw issue: JIRA_FIELDS is
// user-supplied, so caching before extraction would let a script naming
// `attachment` decide how much memory this takes. The key carries a fingerprint
// of the script source, which is why editing a script needs no invalidation.
type Cache struct {
	freshness time.Duration
	// now is a seam for tests; nil means time.Now.
	now func() time.Time

	mu      sync.Mutex
	entries map[entryKey]entry
}

type entryKey struct {
	fingerprint scriptFingerprint
	issueKey    string
}

type scriptFingerprint [sha256.Size]byte

type entry struct {
	result Result
	stored time.Time
}

func newCache(freshness time.Duration) *Cache {
	return &Cache{freshness: freshness, entries: map[entryKey]entry{}}
}

func (c *Cache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func newScriptFingerprint(source string) scriptFingerprint {
	return sha256.Sum256([]byte(source))
}

func newEntryKey(fingerprint scriptFingerprint, issueKey string) entryKey {
	return entryKey{fingerprint: fingerprint, issueKey: strings.ToUpper(issueKey)}
}

// lookup returns the results still fresh for these keys, and the keys that have
// to be checked. A cached result is returned under the spelling the caller
// used, since Jira keys are case-insensitive and a link may not match.
func (c *Cache) lookup(fingerprint scriptFingerprint, keys []string) (map[string]Result, []string) {
	now := c.clock()
	hits := make(map[string]Result, len(keys))
	misses := make([]string, 0, len(keys))

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, key := range keys {
		cacheKey := newEntryKey(fingerprint, key)
		entry, ok := c.entries[cacheKey]
		if ok && now.Sub(entry.stored) >= c.freshness {
			delete(c.entries, cacheKey)
			ok = false
		}
		if !ok {
			misses = append(misses, key)
			continue
		}
		result := entry.result
		result.Key = key
		hits[strings.ToUpper(key)] = result
	}
	return hits, misses
}

func (c *Cache) store(fingerprint scriptFingerprint, results []Result) {
	now := c.clock()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictExpired(now)
	for _, result := range results {
		c.entries[newEntryKey(fingerprint, result.Key)] = entry{result: result, stored: now}
	}
}

func (c *Cache) evictExpired(now time.Time) {
	for k, entry := range c.entries {
		if now.Sub(entry.stored) >= c.freshness {
			delete(c.entries, k)
		}
	}
}
