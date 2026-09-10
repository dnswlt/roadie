package sheet

import (
	"fmt"
	"math"
	"strconv"
)

// laneColors is a knowing duplicate of LANE_COLORS in web/src/colors.ts: a
// workbook is rendered without a browser, so the six hexes have to exist here
// too. The keys are the values stored on lanes; retheme both files together.
var laneColors = map[string]string{
	"blue":   "779DF5",
	"green":  "85AD59",
	"red":    "DC897F",
	"orange": "E7BA51",
	"purple": "BC90C9",
	"gray":   "AA9D90",
}

const defaultLaneColor = "blue"

// coverageSteps quantises a timeline cell's fill: a column reads as a level
// rather than as a shade nobody can compare across rows.
const coverageSteps = 4

// timelineFill is the lane's colour blended toward white by how much of the
// column the work covers, so a fuller column is a stronger one. Any coverage at
// all keeps a visible tint — the value in the cell carries the precision.
func timelineFill(laneColor string, coverage float64) string {
	step := math.Ceil(coverage * coverageSteps)
	step = math.Max(1, math.Min(coverageSteps, step))
	return blendToWhite(laneHex(laneColor), step/coverageSteps)
}

// laneHex is the stored lane colour as RRGGBB, falling back the way
// laneColorValue does for a name this build does not know.
func laneHex(name string) string {
	if hex, ok := laneColors[name]; ok {
		return hex
	}
	return laneColors[defaultLaneColor]
}

// blendToWhite mixes `hex` with white, t = 1 keeping the colour unchanged.
func blendToWhite(hex string, t float64) string {
	var out [3]byte
	for i := range out {
		c, _ := strconv.ParseUint(hex[2*i:2*i+2], 16, 8)
		out[i] = byte(math.Round(255 - (255-float64(c))*t))
	}
	return fmt.Sprintf("%02X%02X%02X", out[0], out[1], out[2])
}
