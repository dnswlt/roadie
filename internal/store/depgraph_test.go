package store

import (
	"reflect"
	"testing"

	"github.com/dnswlt/roadie/internal/model"
)

func in(id int64) depNode { return depNode{kind: model.DepItem, id: id} }
func mn(id int64) depNode { return depNode{kind: model.DepMilestone, id: id} }

func edges(pairs ...[2]depNode) []depEdge {
	es := make([]depEdge, len(pairs))
	for i, p := range pairs {
		es[i] = depEdge{from: p[0], to: p[1]}
	}
	return es
}

func TestFindPath(t *testing.T) {
	// Items and milestones share the graph but not an id space: item 1 and
	// milestone 1 are distinct nodes, which the mixed cases below pin.
	chain := edges([2]depNode{in(1), in(2)}, [2]depNode{in(2), mn(1)}, [2]depNode{mn(1), in(3)})
	tests := []struct {
		name     string
		edges    []depEdge
		src, dst depNode
		want     []depNode
	}{
		{"direct", chain, in(1), in(2), []depNode{in(1), in(2)}},
		{"transitive across kinds", chain, in(1), in(3), []depNode{in(1), in(2), mn(1), in(3)}},
		{"unreachable backwards", chain, in(3), in(1), nil},
		{"kind distinguishes nodes", chain, in(1), mn(3), nil},
		{"branching", edges(
			[2]depNode{in(1), in(2)},
			[2]depNode{in(1), in(3)},
			[2]depNode{in(3), in(4)},
		), in(1), in(4), []depNode{in(1), in(3), in(4)}},
		{"empty graph", nil, in(1), in(2), nil},
	}
	for _, tc := range tests {
		if got := findPath(tc.edges, tc.src, tc.dst); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: findPath = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestFindCycle(t *testing.T) {
	acyclic := [][]depEdge{
		nil,
		edges([2]depNode{in(1), in(2)}),
		// A diamond shares a sink without closing a loop.
		edges(
			[2]depNode{in(1), in(2)},
			[2]depNode{in(1), in(3)},
			[2]depNode{in(2), in(4)},
			[2]depNode{in(3), in(4)},
		),
	}
	for i, es := range acyclic {
		if got := findCycle(es); got != nil {
			t.Errorf("acyclic[%d]: findCycle = %v, want nil", i, got)
		}
	}

	cyclic := [][]depEdge{
		// Direct two-cycle.
		edges([2]depNode{in(1), in(2)}, [2]depNode{in(2), in(1)}),
		// Longer, mixed-kind cycle behind an acyclic prefix.
		edges(
			[2]depNode{in(9), in(1)},
			[2]depNode{in(1), mn(1)},
			[2]depNode{mn(1), in(2)},
			[2]depNode{in(2), in(1)},
		),
	}
	for i, es := range cyclic {
		cycle := findCycle(es)
		if cycle == nil {
			t.Errorf("cyclic[%d]: findCycle = nil, want a cycle", i)
			continue
		}
		// The returned path must be closed and actually walk existing edges.
		if cycle[0] != cycle[len(cycle)-1] {
			t.Errorf("cyclic[%d]: cycle %v is not closed", i, cycle)
		}
		if len(cycle) < 3 {
			t.Errorf("cyclic[%d]: cycle %v too short", i, cycle)
		}
		adj := adjacency(es)
		for j := 0; j+1 < len(cycle); j++ {
			found := false
			for _, next := range adj[cycle[j]] {
				if next == cycle[j+1] {
					found = true
				}
			}
			if !found {
				t.Errorf("cyclic[%d]: cycle %v uses nonexistent edge %v→%v", i, cycle, cycle[j], cycle[j+1])
			}
		}
	}
}

func TestNeedsChain(t *testing.T) {
	labels := map[depNode]string{
		in(1): `"A"`,
		in(2): `"B"`,
		mn(1): `milestone "M"`,
	}
	// Path A → B → M (each node depended on by its successor) reads backwards:
	// the dependent first, down to its root prerequisite.
	got := needsChain([]depNode{in(1), in(2), mn(1)}, labels)
	want := `milestone "M" needs "B", "B" needs "A"`
	if got != want {
		t.Errorf("needsChain = %s, want %s", got, want)
	}
}
