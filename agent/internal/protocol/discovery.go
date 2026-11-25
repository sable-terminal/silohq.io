package protocol

// Industrial discovery (spec 19.2, 19.3, 20.3): an OPC UA server's address space browsed, or an
// MQTT broker's topics observed, structure only. These live here, beside the work frames, so
// the plugins (package work) and discovery (compiled out of the sovereign build) share them.

// DiscoveryEndpoint is an industrial endpoint the organisation already connects to, sent with
// a scan with its login and key sealed for the scan: discovery reaches only these ("where
// credentials already exist").
type DiscoveryEndpoint struct {
	Plugin string `json:"plugin"`
	OPCUAServer
}

// OPCUAStructure is what browsing a server found: its namespaces and, per object type (the
// server's own, or a folder of untyped objects), its instances' variables and references.
// Never a value.
type OPCUAStructure struct {
	NamespaceURIs []string    `json:"namespaceUris"`
	Types         []OPCUAType `json:"types"`
	// Truncated: the browse stopped at its node bound.
	Truncated bool `json:"truncated"`
}

// OPCUAType is one family of instances.
type OPCUAType struct {
	// Name is the type's browse name, or the folder's for untyped objects.
	Name string `json:"name"`
	// TypeDefinition is the type's node by namespace URI; empty for a folder of untyped objects.
	TypeDefinition string `json:"typeDefinition"`
	// Root is the folder holding most of the instances, by namespace URI.
	Root       string           `json:"root"`
	Instances  int              `json:"instances"`
	Variables  []OPCUAVariable  `json:"variables"`
	References []OPCUAReference `json:"references"`
}

// OPCUAVariable is a variable under an instance: its browse path, data type and whether it is
// writable (the access level, an attribute, not a value).
type OPCUAVariable struct {
	Path     string `json:"path"`
	DataType string `json:"dataType"`
	Writable bool   `json:"writable"`
}

// OPCUAReference is a child object of another type at a browse path under an instance.
type OPCUAReference struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// MQTTStructure is what observing a broker found: topic families with the shape of their payloads.
type MQTTStructure struct {
	Families []MQTTFamily `json:"families"`
	// Truncated: the observation stopped at its message or topic bound.
	Truncated bool `json:"truncated"`
}

// MQTTFamily is topics that differ only where a level is an identifier: a filter with +.
type MQTTFamily struct {
	Filter string `json:"filter"`
	Topics int    `json:"topics"`
	// Encoding is the payloads': json, text, sparkplug_b or binary.
	Encoding string           `json:"encoding"`
	Fields   []MQTTFieldShape `json:"fields"`
}

// MQTTFieldShape is a JSON payload's field: its name and JSON type, never its value.
type MQTTFieldShape struct {
	Name string `json:"name"`
	Type string `json:"type"`
}
