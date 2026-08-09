package store

import "github.com/dnswlt/roadie/internal/model"

// Pure graph logic for the dependency DAG, kept free of SQL so depgraph_test.go
// can pin it without a database. Nodes are (kind, id) pairs because items and
// milestones share the graph but not an id space.
//
// Sizing note: both searches are O(nodes + edges) over one roadmap's edges,
// which the callers load in a single query. That is the whole efficiency
// story — dependency graphs are roadmap-scoped and edited one edge at a time,
// so there is nothing here for an incremental algorithm to earn.

type depNode struct {
	kind string // model.DepItem or model.DepMilestone
	id   int64
}

func nodeOf(ref model.DependencyRef) depNode { return depNode{kind: ref.Kind, id: ref.ID} }

type depEdge struct {
	from, to depNode
}

// adjacency builds the forward adjacency map (prerequisite → dependents).
func adjacency(edges []depEdge) map[depNode][]depNode {
	adj := make(map[depNode][]depNode, len(edges))
	for _, e := range edges {
		adj[e.from] = append(adj[e.from], e.to)
	}
	return adj
}

// findPath returns a directed path from src to dst over edges, inclusive of
// both endpoints, or nil if dst is unreachable. Used by CreateDependency: a
// path to→from means from already (transitively) depends on to, so adding
// from→to would close a cycle — and the path itself is the diagnostic.
func findPath(edges []depEdge, src, dst depNode) []depNode {
	adj := adjacency(edges)
	seen := map[depNode]bool{src: true}
	var dfs func(n depNode) []depNode
	dfs = func(n depNode) []depNode {
		if n == dst {
			return []depNode{n}
		}
		for _, next := range adj[n] {
			if seen[next] {
				continue
			}
			seen[next] = true
			if path := dfs(next); path != nil {
				return append([]depNode{n}, path...)
			}
		}
		return nil
	}
	return dfs(src)
}

// findCycle returns one directed cycle in edges as a node sequence whose first
// element is repeated at the end (v0 → v1 → ... → v0), or nil if the graph is
// acyclic. Used to validate a whole edge set at once (import, restore), where
// there is no single new edge to blame.
func findCycle(edges []depEdge) []depNode {
	adj := adjacency(edges)
	const (
		white = 0 // unvisited
		gray  = 1 // on the current DFS stack
		black = 2 // fully explored, cycle-free
	)
	color := map[depNode]int{}
	var stack []depNode

	// dfs returns the node closing a cycle (a gray node reached again), or a
	// zero flag; the stack then holds the cycle's body.
	var dfs func(n depNode) (depNode, bool)
	dfs = func(n depNode) (depNode, bool) {
		color[n] = gray
		stack = append(stack, n)
		for _, next := range adj[n] {
			switch color[next] {
			case gray:
				return next, true
			case white:
				if hit, ok := dfs(next); ok {
					return hit, ok
				}
			}
		}
		color[n] = black
		stack = stack[:len(stack)-1]
		return depNode{}, false
	}

	for _, e := range edges {
		if color[e.from] != white {
			continue
		}
		stack = stack[:0]
		hit, ok := dfs(e.from)
		if !ok {
			continue
		}
		// The cycle is the stack from the reentered node onward, closed by
		// repeating it at the end.
		for i, n := range stack {
			if n == hit {
				return append(append([]depNode{}, stack[i:]...), hit)
			}
		}
	}
	return nil
}
