package work

import (
	"encoding/binary"
	"math"
	"testing"
)

func pbVarint(v uint64) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			out = append(out, b|0x80)
			continue
		}
		return append(out, b)
	}
}

func pbLen(field uint64, body []byte) []byte {
	out := append(pbVarint(field<<3|2), pbVarint(uint64(len(body)))...)
	return append(out, body...)
}

func pbMetric(name string, alias uint64, datatype uint64, value []byte) []byte {
	var m []byte
	if name != "" {
		m = append(m, pbLen(1, []byte(name))...)
	}
	if alias != 0 {
		m = append(m, pbVarint(2<<3)...)
		m = append(m, pbVarint(alias)...)
	}
	m = append(m, pbVarint(4<<3)...)
	m = append(m, pbVarint(datatype)...)
	return pbLen(2, append(m, value...))
}

// A birth names its metrics with their types; a data message by alias alone adds nothing; the values are never kept.
func TestSparkplugShapeIsNamesAndTypesOnly(t *testing.T) {
	speed := make([]byte, 9)
	speed[0] = 13<<3 | 1
	binary.LittleEndian.PutUint64(speed[1:], math.Float64bits(1450.5))
	birth := append(append(pbVarint(1<<3), pbVarint(1763800000000)...),
		append(pbMetric("Speed", 10, 10, speed), pbMetric("Running", 11, 11, []byte{14 << 3, 1})...)...)
	birth = append(birth, pbMetric("Table", 12, 16, pbLen(17, []byte{8, 1}))...)
	fields, err := sparkplugShape(birth)
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 2 || fields["Speed"] != "number" || fields["Running"] != "boolean" {
		t.Fatalf("shape %v", fields)
	}
	data, err := sparkplugShape(pbMetric("", 10, 10, speed))
	if err != nil || len(data) != 0 {
		t.Fatalf("an alias alone names nothing: %v %v", data, err)
	}
	if shape := shapeOf("spBv1.0/Plant1/DBIRTH/Edge7/Pump3", birth); shape.payload != "sparkplug_b" || len(shape.fields) != 2 {
		t.Fatalf("on its namespace: %+v", shape)
	}
	if shape := shapeOf("spBv1.0/Plant1/DDATA/Edge7/Pump3", []byte{0x12, 0x40}); shape.payload != "binary" {
		t.Fatalf("broken bytes are not Sparkplug: %+v", shape)
	}
	if shape := shapeOf("plant/pump3", birth); shape.payload == "sparkplug_b" {
		t.Fatalf("off the namespace a payload is not read as Sparkplug: %+v", shape)
	}
}
