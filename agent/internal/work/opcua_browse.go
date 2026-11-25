package work

// Browse (spec 19.2, 19.3, 19.4, 20.3): discovery's look at a server the organisation already
// connects to, structure only. From the Objects folder it descends folders (FolderType, and
// untyped objects that hold no variables of their own) and takes as instances the objects of a
// type of the server's own, and untyped objects with variables. Instances are grouped by their
// type, or by their folder when untyped: the proposed object types. For a few instances of each
// it walks the variables (their browse paths, data types and access levels: attributes, never a
// value) and the child objects of other types (the references, proposed as links). The server's
// own objects (namespace 0) are not read. Bounded: at most 5,000 nodes browsed, 8 levels deep.

import (
	"context"
	"sort"
	"strings"

	"github.com/gopcua/opcua/id"
	"github.com/gopcua/opcua/ua"

	"silohq.io/agent/internal/protocol"
)

const (
	maxBrowseNodes   = 5_000
	maxBrowseDepth   = 8
	browseSamples    = 3
	maxInstanceDepth = 4
)

// builtInTypes are namespace 0's data types by number, as the cell maps them to field types.
var builtInTypes = map[uint32]string{
	1: "Boolean", 2: "SByte", 3: "Byte", 4: "Int16", 5: "UInt16", 6: "Int32", 7: "UInt32", 8: "Int64", 9: "UInt64",
	10: "Float", 11: "Double", 12: "String", 13: "DateTime", 14: "Guid", 15: "ByteString", 16: "XmlElement", 17: "NodeId",
	18: "ExpandedNodeId", 19: "StatusCode", 20: "QualifiedName", 21: "LocalizedText", 22: "Structure", 23: "DataValue",
	24: "BaseDataType", 25: "DiagnosticInfo", 26: "Number", 27: "Integer", 28: "UInteger", 29: "Enumeration",
	290: "Duration", 294: "UtcTime", 295: "LocaleId",
}

type browseNode struct {
	id         *ua.NodeID
	browseName string
	class      ua.NodeClass
	typeDef    *ua.NodeID
}

// untypedOrFolder is whether a type definition is none, BaseObjectType or FolderType.
func untypedOrFolder(t *ua.NodeID) bool {
	return t == nil || (t.Namespace() == 0 && (t.IntID() == 0 || t.IntID() == id.BaseObjectType || t.IntID() == id.FolderType))
}

func isFolder(t *ua.NodeID) bool {
	return t != nil && t.Namespace() == 0 && t.IntID() == id.FolderType
}

type browser struct {
	sess      *opcuaSession
	budget    int
	truncated bool
}

// childNodes are a node's hierarchical children, objects and variables, counted against the bound.
func (b *browser) childNodes(ctx context.Context, node *ua.NodeID) ([]browseNode, error) {
	if b.budget <= 0 {
		b.truncated = true
		return nil, nil
	}
	b.budget--
	refs, err := b.sess.client.Node(node).References(ctx, id.HierarchicalReferences, ua.BrowseDirectionForward, ua.NodeClassObject|ua.NodeClassVariable, true)
	if err != nil {
		return nil, err
	}
	out := make([]browseNode, 0, len(refs))
	for _, ref := range refs {
		if ref.NodeID == nil || ref.NodeID.NodeID == nil || ref.BrowseName == nil {
			continue
		}
		n := browseNode{id: ref.NodeID.NodeID, browseName: ref.BrowseName.Name, class: ref.NodeClass}
		if ref.TypeDefinition != nil {
			n.typeDef = ref.TypeDefinition.NodeID
		}
		out = append(out, n)
	}
	return out, nil
}

type family struct {
	name      string
	typeDef   *ua.NodeID
	parents   map[string]int
	instances []browseNode
}

// Browse reads the server's structure: the families of instances, their variables and references.
func (o *OPCUA) Browse(ctx context.Context, server protocol.OPCUAServer) (*protocol.OPCUAStructure, *protocol.Error) {
	sess, _, refusal := o.connect(ctx, server)
	if refusal != nil {
		return nil, refusal
	}
	defer sess.client.Close(context.Background())
	b := &browser{sess: sess, budget: maxBrowseNodes}
	families := map[string]*family{}
	var order []string
	add := func(key, name string, typeDef *ua.NodeID, parent *ua.NodeID, n browseNode) {
		f := families[key]
		if f == nil {
			f = &family{name: name, typeDef: typeDef, parents: map[string]int{}}
			families[key] = f
			order = append(order, key)
		}
		f.parents[sess.address(parent)]++
		f.instances = append(f.instances, n)
	}
	var walk func(node *ua.NodeID, name string, kids []browseNode, depth int) error
	walk = func(node *ua.NodeID, name string, kids []browseNode, depth int) error {
		for _, k := range kids {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// The server's own objects (namespace 0: Server, its diagnostics) are not the customer's.
			if k.class != ua.NodeClassObject || k.id.Namespace() == 0 {
				continue
			}
			if !untypedOrFolder(k.typeDef) {
				add("type:"+k.typeDef.String(), "", k.typeDef, node, k)
				continue
			}
			if depth >= maxBrowseDepth {
				b.truncated = true
				continue
			}
			grand, err := b.childNodes(ctx, k.id)
			if err != nil {
				return err
			}
			hasVariables := false
			for _, g := range grand {
				if g.class == ua.NodeClassVariable {
					hasVariables = true
					break
				}
			}
			if hasVariables && !isFolder(k.typeDef) {
				// An untyped object with variables: an instance of its folder's family.
				add("folder:"+node.String(), name, nil, node, k)
				continue
			}
			if err := walk(k.id, k.browseName, grand, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	root := ua.NewNumericNodeID(0, id.ObjectsFolder)
	top, err := b.childNodes(ctx, root)
	if err != nil {
		return nil, failed(protocol.SourceRefused)
	}
	if err := walk(root, "Objects", top, 1); err != nil {
		return nil, failed(protocol.SourceRefused)
	}
	typeNames := map[string]string{}
	nameOf := func(t *ua.NodeID) string {
		key := t.String()
		if name, ok := typeNames[key]; ok {
			return name
		}
		name := key
		if q, err := sess.client.Node(t).BrowseName(ctx); err == nil && q != nil && q.Name != "" {
			name = q.Name
		}
		typeNames[key] = name
		return name
	}
	out := &protocol.OPCUAStructure{NamespaceURIs: sess.namespaces, Types: []protocol.OPCUAType{}}
	for _, key := range order {
		f := families[key]
		t := protocol.OPCUAType{Name: f.name, Instances: len(f.instances), Variables: []protocol.OPCUAVariable{}, References: []protocol.OPCUAReference{}}
		if f.typeDef != nil {
			t.Name = nameOf(f.typeDef)
			t.TypeDefinition = sess.address(f.typeDef)
		}
		best := 0
		for parent, n := range f.parents {
			if n > best || (n == best && parent < t.Root) {
				t.Root, best = parent, n
			}
		}
		variables := map[string]*ua.NodeID{}
		references := map[string]string{}
		for i, instance := range f.instances {
			if i >= browseSamples {
				break
			}
			if err := b.shape(ctx, instance.id, "", 1, variables, references, nameOf); err != nil {
				return nil, failed(protocol.SourceRefused)
			}
		}
		paths := make([]string, 0, len(variables))
		for p := range variables {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		described, err := b.describe(ctx, paths, variables)
		if err != nil {
			return nil, failed(protocol.SourceRefused)
		}
		t.Variables = described
		for p, typ := range references {
			t.References = append(t.References, protocol.OPCUAReference{Path: p, Type: typ})
		}
		sort.Slice(t.References, func(i, j int) bool { return t.References[i].Path < t.References[j].Path })
		out.Types = append(out.Types, t)
	}
	sort.Slice(out.Types, func(i, j int) bool { return out.Types[i].Name < out.Types[j].Name })
	out.Truncated = b.truncated
	return out, nil
}

// shape walks an instance: its variables by browse path, untyped child objects as part of it,
// child objects of a type as references. Variables' own properties are not walked.
func (b *browser) shape(ctx context.Context, node *ua.NodeID, prefix string, depth int, variables map[string]*ua.NodeID,
	references map[string]string, nameOf func(*ua.NodeID) string) error {
	kids, err := b.childNodes(ctx, node)
	if err != nil {
		return err
	}
	for _, k := range kids {
		if strings.Contains(k.browseName, "/") {
			// A browse path cannot name it.
			continue
		}
		path := k.browseName
		if prefix != "" {
			path = prefix + "/" + k.browseName
		}
		switch {
		case k.class == ua.NodeClassVariable:
			if _, seen := variables[path]; !seen {
				variables[path] = k.id
			}
		case !untypedOrFolder(k.typeDef):
			// A child of another type: a reference, and its variables part of the instance too.
			references[path] = nameOf(k.typeDef)
			if depth < maxInstanceDepth {
				if err := b.shape(ctx, k.id, path, depth+1, variables, references, nameOf); err != nil {
					return err
				}
			}
		case depth < maxInstanceDepth:
			if err := b.shape(ctx, k.id, path, depth+1, variables, references, nameOf); err != nil {
				return err
			}
		}
	}
	return nil
}

// describe reads each variable's data type and access level: attributes, never its value.
func (b *browser) describe(ctx context.Context, paths []string, variables map[string]*ua.NodeID) ([]protocol.OPCUAVariable, error) {
	out := make([]protocol.OPCUAVariable, 0, len(paths))
	dataTypeNames := map[string]string{}
	for start := 0; start < len(paths); start += opcuaReadChunk / 2 {
		end := min(start+opcuaReadChunk/2, len(paths))
		reads := make([]*ua.ReadValueID, 0, 2*(end-start))
		for _, p := range paths[start:end] {
			reads = append(reads,
				&ua.ReadValueID{NodeID: variables[p], AttributeID: ua.AttributeIDDataType},
				&ua.ReadValueID{NodeID: variables[p], AttributeID: ua.AttributeIDAccessLevel})
		}
		res, err := b.sess.client.Read(ctx, &ua.ReadRequest{NodesToRead: reads, TimestampsToReturn: ua.TimestampsToReturnNeither})
		if err != nil || len(res.Results) != len(reads) {
			return nil, err
		}
		for i, p := range paths[start:end] {
			v := protocol.OPCUAVariable{Path: p, DataType: "BaseDataType"}
			if dt := res.Results[2*i]; dt.Status == ua.StatusOK && dt.Value != nil {
				if node, ok := dt.Value.Value().(*ua.NodeID); ok && node != nil {
					v.DataType = b.dataTypeName(ctx, node, dataTypeNames)
				}
			}
			if al := res.Results[2*i+1]; al.Status == ua.StatusOK && al.Value != nil {
				if level, ok := al.Value.Value().(byte); ok {
					v.Writable = level&byte(ua.AccessLevelTypeCurrentWrite) != 0
				}
			}
			out = append(out, v)
		}
	}
	return out, nil
}

func (b *browser) dataTypeName(ctx context.Context, node *ua.NodeID, cache map[string]string) string {
	if node.Namespace() == 0 {
		if name, ok := builtInTypes[node.IntID()]; ok {
			return name
		}
	}
	key := node.String()
	if name, ok := cache[key]; ok {
		return name
	}
	name := "Structure"
	if q, err := b.sess.client.Node(node).BrowseName(ctx); err == nil && q != nil && q.Name != "" {
		name = q.Name
	}
	cache[key] = name
	return name
}
