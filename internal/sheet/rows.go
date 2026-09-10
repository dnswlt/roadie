package sheet

import "github.com/dnswlt/roadie/internal/model"

type rowKind int

const (
	kindMilestone rowKind = iota
	kindItem
	kindChild
)

func (k rowKind) String() string {
	switch k {
	case kindMilestone:
		return "Milestone"
	case kindChild:
		return "Sub-item"
	default:
		return "Item"
	}
}

// row is one resolved sheet line: the nesting flattened away, with everything
// the columns need already on it. The sheet is a flat table — the context name
// repeats on every row rather than heading a group, so a filter or a pivot over
// it sees complete records.
type row struct {
	wbs  string
	ref  model.DependencyRef
	kind rowKind
	// Context name and colour; the colour drives the timeline fill.
	context string
	color   string

	title       string
	description string
	// A milestone puts its date in both ends — the model's own rule, shared
	// with deps-graph.ts — which is what lets it take part in span arithmetic
	// and in the dependency date check.
	start, end model.Date

	priority  *int
	labels    []string
	flagged   bool
	tentative bool
	atRisk    bool
	// "Integration", "Mirror", or empty when the milestone has no cross-roadmap
	// role and on every item. It is shown as the row's type: only milestones
	// carry one, so it cannot be confused with an item's.
	linkage string
}

// typeText is what the Type column shows: the kind, or the cross-roadmap role
// where the milestone has one.
func (r row) typeText() string {
	if r.linkage != "" {
		return r.linkage
	}
	return r.kind.String()
}

// duration is the inclusive day count of an item. Milestones have none.
func (r row) duration() int {
	if r.kind == kindMilestone {
		return 0
	}
	return dayOf(r.end) - dayOf(r.start) + 1
}

// buildRows flattens a roadmap into canonical sheet order: contexts by
// position, within each its milestones by date then its items by rank, each
// parent's children directly after it. The payload already arrives in that
// order (store.GetRoadmapFull), so this only walks it.
func buildRows(rm model.RoadmapFull) []row {
	var rows []row
	for li, lane := range rm.Lanes {
		context := contextLabel(li)
		n := 0 // one sequence over the context's milestones and items alike
		for _, ms := range lane.Milestones {
			n++
			rows = append(rows, row{
				wbs:         entityLabel(context, n),
				ref:         model.DependencyRef{Kind: model.DepMilestone, ID: ms.ID},
				kind:        kindMilestone,
				context:     lane.Name,
				color:       lane.Color,
				title:       ms.Title,
				description: ms.Description,
				start:       ms.Date,
				end:         ms.Date,
				labels:      ms.Labels,
				flagged:     ms.Flagged,
				tentative:   ms.Tentative,
				atRisk:      ms.AtRisk,
				linkage:     linkageText(ms),
			})
		}
		for _, item := range lane.Items {
			n++
			wbs := entityLabel(context, n)
			rows = append(rows, itemRow(wbs, kindItem, lane.Lane, item.Item))
			for ci, child := range item.Children {
				rows = append(rows, itemRow(childLabel(wbs, ci), kindChild, lane.Lane, child))
			}
		}
	}
	return rows
}

func itemRow(wbs string, kind rowKind, lane model.Lane, it model.Item) row {
	return row{
		wbs:         wbs,
		ref:         model.DependencyRef{Kind: model.DepItem, ID: it.ID},
		kind:        kind,
		context:     lane.Name,
		color:       lane.Color,
		title:       it.Title,
		description: it.Description,
		start:       it.StartDate,
		end:         it.EndDate,
		priority:    it.Priority,
		labels:      it.Labels,
		flagged:     it.Flagged,
		tentative:   it.Tentative,
		atRisk:      it.AtRisk,
	}
}

func linkageText(ms model.Milestone) string {
	switch {
	case ms.IsIntegration():
		return "Integration"
	case ms.IsMirror():
		return "Mirror"
	default:
		return ""
	}
}
