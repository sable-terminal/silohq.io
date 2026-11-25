//go:build !windows

package discovery

// registryReferences is Windows's: elsewhere, ODBC data sources are in files.
func registryReferences() []reference { return nil }
