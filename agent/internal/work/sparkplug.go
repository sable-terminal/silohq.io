package work

// Sparkplug B's shape (spec 19.3, 20.2; D211), for discovery's look at a broker: of a payload on
// a spBv1.0/... topic, the names of its metrics and the JSON type their values take, read by
// hand from the protocol buffer's wire format. Values are read past, never kept: discovery is
// structure only. A metric named only by its alias (a DATA message) adds nothing; its birth
// names it. Bytes that are not a Sparkplug payload are not one.

import (
	"errors"
	"strings"
)

const sparkplugNamespace = "spBv1.0/"

var errNotSparkplug = errors.New("not a Sparkplug B payload")

type pbReader struct {
	buf []byte
	at  int
}

func (r *pbReader) done() bool { return r.at >= len(r.buf) }

func (r *pbReader) varint() (uint64, error) {
	var out uint64
	for shift := uint(0); shift < 64; shift += 7 {
		if r.at >= len(r.buf) {
			return 0, errNotSparkplug
		}
		b := r.buf[r.at]
		r.at++
		out |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return out, nil
		}
	}
	return 0, errNotSparkplug
}

func (r *pbReader) take(n int) ([]byte, error) {
	if n < 0 || r.at+n > len(r.buf) {
		return nil, errNotSparkplug
	}
	out := r.buf[r.at : r.at+n]
	r.at += n
	return out, nil
}

func (r *pbReader) skip(wire uint64) error {
	switch wire {
	case 0:
		_, err := r.varint()
		return err
	case 1:
		_, err := r.take(8)
		return err
	case 2:
		n, err := r.varint()
		if err != nil {
			return err
		}
		_, err = r.take(int(n))
		return err
	case 5:
		_, err := r.take(4)
		return err
	}
	return errNotSparkplug
}

// sparkplugType is the JSON type a Sparkplug datatype's value takes; "" for those discovery does not read.
func sparkplugType(datatype uint64) string {
	switch {
	case datatype >= 1 && datatype <= 10, datatype == 13:
		return "number"
	case datatype == 11:
		return "boolean"
	case datatype == 12, datatype == 14, datatype == 15, datatype == 17, datatype == 18:
		return "string"
	}
	return ""
}

// sparkplugShape is a payload's metric names and their JSON types.
func sparkplugShape(payload []byte) (map[string]string, error) {
	fields := map[string]string{}
	r := &pbReader{buf: payload}
	for !r.done() {
		key, err := r.varint()
		if err != nil {
			return nil, err
		}
		field, wire := key>>3, key&7
		if field != 2 || wire != 2 {
			if err := r.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		n, err := r.varint()
		if err != nil {
			return nil, err
		}
		body, err := r.take(int(n))
		if err != nil {
			return nil, err
		}
		name, datatype, err := metricShape(body)
		if err != nil {
			return nil, err
		}
		if typ := sparkplugType(datatype); name != "" && typ != "" && len(fields) < 500 {
			fields[name] = typ
		}
	}
	return fields, nil
}

func metricShape(body []byte) (string, uint64, error) {
	r := &pbReader{buf: body}
	var name string
	var datatype uint64
	for !r.done() {
		key, err := r.varint()
		if err != nil {
			return "", 0, err
		}
		field, wire := key>>3, key&7
		switch {
		case field == 1 && wire == 2:
			n, err := r.varint()
			if err != nil {
				return "", 0, err
			}
			b, err := r.take(int(n))
			if err != nil {
				return "", 0, err
			}
			name = string(b)
		case field == 4 && wire == 0:
			if datatype, err = r.varint(); err != nil {
				return "", 0, err
			}
		default:
			if err := r.skip(wire); err != nil {
				return "", 0, err
			}
		}
	}
	return name, datatype, nil
}

func isSparkplugTopic(topic string) bool { return strings.HasPrefix(topic, sparkplugNamespace) }
