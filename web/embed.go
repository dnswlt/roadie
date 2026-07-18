// Package web embeds the built frontend assets for release builds.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
