package tunnel

// Change capture over the tunnel (spec 10.3, 10.4, 10.6). The cell leases a slot to this agent
// with cdc.start. The agent runs a reader whose changes go into the spool (package spool,
// encrypted, bounded), and an uploader that sends what the spool holds up a stream of its own,
// POST /v1/cdc/:slotId, in log order: first any gap records, then the records, saying when the
// reader streams. The cell acknowledges positions with cdc.ack once it has taken them in, and
// the spool lets them go; it acknowledges gap records with cdc.gap_ack.
//
//   - When the tunnel drops, or the cell is slow, the uploader stops or lags and the reader
//     reads on into the spool (store-and-forward, 10.6; "CDC readers slow and spool", 9.4). The
//     heartbeat names the slots it reads and the spools that hold what the source no longer
//     has, so on reconnecting the cell gives them back to this agent.
//   - A capture the agent cannot read (no replication login, a method it does not read, no
//     room) is refused on a stream of its own, so the cell offers it elsewhere. A reader's end
//     (lost slot, failure) goes up after what the spool holds.
//   - cdc.stop ends the reader and the uploader. The spool goes with them unless it holds what
//     only it has (records the source was told it may let go of, or gap records the cell has
//     not had): the source still holds the rest for the next reader.
//   - cdc.drop ends both, drops the slot on the customer's database and the spool, and reports it.

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"silohq.io/agent/internal/cdc"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/spool"
)

// dropWithin bounds a drop, which waits for the slot's reader to let it go.
const dropWithin = 2 * time.Minute

// uploaderPoll is how often an uploader with nothing to send looks for gap records and the reader's end.
const uploaderPoll = 250 * time.Millisecond

// ReplicationDSNs finds a connection's replication login in the agent's configuration.
type ReplicationDSNs func(connectionID string) (dsn string, known bool, err error)

// source is a capture's reader on the customer's database: Postgres logical replication, or a
// MySQL binary log.
type source interface {
	Run(ctx context.Context) error
	Ack(position string) error
	AtRiskNow() bool
}

type reader struct {
	slotID    string
	cancel    context.CancelFunc
	pg        source
	queue     *spool.Queue
	streaming atomic.Bool
	done      chan struct{}
	outcome   atomic.Value // a frame: lost or error
}

type uploader struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type captures struct {
	mu        sync.Mutex
	readers   map[string]*reader
	uploaders map[string]*uploader
	// telemetry are the mqtt captures running here: no reader, no spool.
	telemetry map[string]*subscription
}

// Telemetry subscribes for an mqtt capture (work.MQTT): started once subscribed, then batches
// of messages, until ctx ends; the error frame says why it ended otherwise.
type Telemetry interface {
	Subscribe(ctx context.Context, connectionID, slotID string, sub *protocol.MQTTCapture, started func() error,
		deliver func(messages []map[string]any) error) *protocol.Error
}

// Monitoring runs an opcua capture (work.OPCUA): started once its items are monitored, then
// batches of samples, until ctx ends; the error frame says why it ended otherwise.
type Monitoring interface {
	Monitor(ctx context.Context, connectionID, slotID string, sub *protocol.OPCUACapture, started func() error,
		deliver func(samples []map[string]any) error) *protocol.Error
}

type subscription struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// cdcState is what the heartbeat says: the slots read here, and the spools holding what only they have.
func (c *Client) cdcState() (reading, spooled []string) {
	c.cdc.mu.Lock()
	for id := range c.cdc.readers {
		reading = append(reading, id)
	}
	for id := range c.cdc.telemetry {
		reading = append(reading, id)
	}
	c.cdc.mu.Unlock()
	if c.settings.Spool == nil {
		return reading, nil
	}
	for _, id := range c.settings.Spool.Slots() {
		c.cdc.mu.Lock()
		_, running := c.cdc.readers[id]
		c.cdc.mu.Unlock()
		if running || len(spooled) >= protocol.MaxSpooledSlots {
			continue
		}
		if q, err := c.settings.Spool.Queue(id); err == nil && (q.Precious() || len(q.Gaps()) > 0) {
			spooled = append(spooled, id)
		}
	}
	return reading, spooled
}

// stopUploads ends every uploader (the tunnel is down); the readers read on into the spool.
func (c *Client) stopUploads() {
	c.cdc.mu.Lock()
	defer c.cdc.mu.Unlock()
	for id, u := range c.cdc.uploaders {
		u.cancel()
		delete(c.cdc.uploaders, id)
	}
}

// stopCapture ends the slot's reader and uploader, waiting for the reader to let the slot go.
func (c *Client) stopCapture(slotID string) {
	c.cdc.mu.Lock()
	if t := c.cdc.telemetry[slotID]; t != nil {
		t.cancel()
		delete(c.cdc.telemetry, slotID)
	}
	r := c.cdc.readers[slotID]
	delete(c.cdc.readers, slotID)
	if u := c.cdc.uploaders[slotID]; u != nil {
		u.cancel()
		delete(c.cdc.uploaders, slotID)
	}
	c.cdc.mu.Unlock()
	if r != nil {
		r.cancel()
		select {
		case <-r.done:
		case <-time.After(30 * time.Second):
		}
	}
}

func (c *Client) onCapture(ctx context.Context, client *http.Client, frame protocol.Down) {
	switch frame.Type {
	case "cdc.ack":
		if c.settings.Spool != nil {
			if q, err := c.settings.Spool.Queue(frame.SlotID); err == nil {
				if frame.Received != "" {
					q.Received(frame.Received)
				}
				if order, err := cdc.Order(frame.Position); frame.Position != "" && err == nil {
					q.Ack(order)
				}
			}
		}
		c.cdc.mu.Lock()
		r := c.cdc.readers[frame.SlotID]
		c.cdc.mu.Unlock()
		if r != nil && frame.Position != "" {
			_ = r.pg.Ack(frame.Position)
		}
	case "cdc.gap_ack":
		if c.settings.Spool != nil {
			if q, err := c.settings.Spool.Queue(frame.SlotID); err == nil {
				_ = q.AckGap(frame.GapID)
			}
		}
	case "cdc.stop":
		c.stopCapture(frame.SlotID)
		if c.settings.Spool != nil {
			if q, err := c.settings.Spool.Queue(frame.SlotID); err == nil && !q.Precious() && len(q.Gaps()) == 0 {
				_ = c.settings.Spool.Remove(frame.SlotID)
			}
		}
	case "cdc.drop":
		c.stopCapture(frame.SlotID)
		go c.dropCapture(ctx, client, frame)
	case "cdc.start":
		c.startCapture(ctx, client, frame)
	}
}

func (c *Client) startCapture(ctx context.Context, client *http.Client, frame protocol.Down) {
	log := c.settings.Logger.With("slot_id", frame.SlotID)
	if frame.Method == "mqtt" || frame.Method == "opcua" {
		c.startTelemetry(ctx, client, frame)
		return
	}
	if c.settings.Spool == nil {
		go c.reportCapture(ctx, client, frame.SlotID, protocol.NewError(protocol.NotConfigured, ""))
		return
	}
	r, refusal := c.ensureReader(frame)
	if refusal != nil {
		log.Warn("change capture not started here", "event", "agent.cdc_refused", "category", refusal.Category)
		go c.reportCapture(ctx, client, frame.SlotID, *refusal)
		return
	}
	uctx, cancel := context.WithCancel(ctx)
	u := &uploader{cancel: cancel, done: make(chan struct{})}
	c.cdc.mu.Lock()
	if old := c.cdc.uploaders[frame.SlotID]; old != nil {
		old.cancel()
	}
	c.cdc.uploaders[frame.SlotID] = u
	c.cdc.mu.Unlock()
	go func() {
		defer close(u.done)
		defer cancel()
		c.upload(uctx, client, r)
		c.cdc.mu.Lock()
		if c.cdc.uploaders[frame.SlotID] == u {
			delete(c.cdc.uploaders, frame.SlotID)
		}
		c.cdc.mu.Unlock()
	}()
}

// ensureReader is the slot's reader, started if it is not running: from the acknowledged
// position, or past what the spool already holds.
func (c *Client) ensureReader(frame protocol.Down) (*reader, *protocol.Error) {
	c.cdc.mu.Lock()
	defer c.cdc.mu.Unlock()
	if r := c.cdc.readers[frame.SlotID]; r != nil {
		return r, nil
	}
	if len(c.cdc.readers) >= protocol.MaxCDCReaders {
		refusal := protocol.NewError(protocol.Capacity, "")
		return nil, &refusal
	}
	var dsn string
	known := false
	if c.settings.ReplicationDSNs != nil {
		var err error
		if dsn, known, err = c.settings.ReplicationDSNs(frame.ConnectionID); err != nil {
			known = false
		}
	}
	if !known {
		refusal := protocol.NewError(protocol.NotConfigured, "")
		return nil, &refusal
	}
	queue, err := c.settings.Spool.Queue(frame.SlotID)
	if err != nil {
		refusal := protocol.NewError(protocol.Internal, "")
		return nil, &refusal
	}
	start := frame.Position
	if order, position := queue.LastFinal(); position != "" {
		if from, err := cdc.Order(start); start == "" || (err == nil && order > from) {
			start = position
		}
	}
	log := c.settings.Logger.With("slot_id", frame.SlotID)
	rctx, cancel := context.WithCancel(c.root)
	r := &reader{slotID: frame.SlotID, cancel: cancel, queue: queue, done: make(chan struct{})}
	emit := func(batch cdc.Batch) error {
		raw, err := protocol.Marshal(batch)
		if err != nil {
			return err
		}
		// Only a slot about to be invalidated may lose spooled changes to the bound; otherwise reading waits.
		err = queue.Append(spool.Record{Order: batch.Order, Final: batch.Position != "", Position: batch.Position,
			CommittedAt: batch.CommittedAt, Changes: len(batch.Changes), Frame: raw}, r.pg.AtRiskNow())
		if errors.Is(err, spool.ErrFull) {
			return cdc.ErrFull
		}
		return err
	}
	started := func() error { r.streaming.Store(true); return nil }
	tables := make([][2]string, 0, len(frame.Tables))
	for _, t := range frame.Tables {
		tables = append(tables, [2]string{t.Schema, t.Table})
	}
	switch frame.Method {
	case "change_tracking":
		r.pg = &cdc.ChangeTracking{DSN: dsn, Tables: tables, Start: start, Logger: log, Emit: emit, Started: started}
	case "binlog":
		r.pg = &cdc.MySQL{DSN: dsn, SlotID: frame.SlotID, SlotName: frame.SlotName, Tables: tables, Start: start, Logger: log, Emit: emit, Started: started}
	default:
		r.pg = &cdc.Postgres{
			DSN: dsn, SlotName: frame.SlotName, Publication: frame.Publication, Start: start, Logger: log, Emit: emit, Started: started,
			Confirmable: func() uint64 {
				order, _ := queue.Synced()
				return order
			},
			SourceConfirmed: func(order uint64) { _ = queue.SourceConfirmed(order) },
			Ahead: func(from, to string) {
				log.Warn("the slot stands past the acknowledged position: another agent's spool held what lies between", "event", "agent.cdc_resumed_ahead")
				_ = queue.AddGap(spool.Gap{Reason: "resumed_ahead", Records: -1, Changes: -1, FromPosition: from, ToPosition: to})
			},
		}
	}
	c.cdc.readers[frame.SlotID] = r
	go func() {
		defer close(r.done)
		err := r.pg.Run(rctx)
		switch {
		case err == nil || rctx.Err() != nil:
		case errors.Is(err, cdc.ErrLost):
			log.Warn("the replication slot is gone or invalidated", "event", "agent.cdc_slot_lost")
			r.outcome.Store(any(protocol.Note{Type: "lost"}))
		case errors.Is(err, cdc.ErrNotConfigured):
			r.outcome.Store(any(protocol.NewError(protocol.SourceNotConfigured, "")))
		default:
			// The failure's kind and SQLSTATE only: the source's own text may hold names or values.
			category, sqlstate := cdc.Failure(err)
			log.Warn("change capture stopped", "event", "agent.cdc_failed", "category", category, "sqlstate", sqlstate)
			r.outcome.Store(any(protocol.NewError(category, sqlstate)))
		}
		c.cdc.mu.Lock()
		if c.cdc.readers[frame.SlotID] == r {
			delete(c.cdc.readers, frame.SlotID)
		}
		c.cdc.mu.Unlock()
	}()
	return r, nil
}

// upload sends the spool up one capture stream until the stream, the tunnel or the reader ends.
func (c *Client) upload(ctx context.Context, client *http.Client, r *reader) {
	body, writer := io.Pipe()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(c.settings)+protocol.CDCPathPrefix+r.slotID, body)
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/x-ndjson")
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		res, err := client.Do(req)
		if err != nil {
			_ = body.CloseWithError(err)
			return
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		_ = body.Close()
	}()
	defer func() {
		_ = writer.Close()
		<-answered
	}()
	frames := protocol.NewWriter(writer)
	sentGaps := map[string]bool{}
	started := false
	cursor := r.queue.Cursor()
	for ctx.Err() == nil {
		for _, g := range r.queue.Gaps() {
			if !sentGaps[g.ID] {
				if frames.Write(gapFrame(g)) != nil {
					return
				}
				sentGaps[g.ID] = true
			}
		}
		if !started && r.streaming.Load() {
			if frames.Write(protocol.Note{Type: "started"}) != nil {
				return
			}
			started = true
		}
		wait, stop := context.WithTimeout(ctx, uploaderPoll)
		rec, err := cursor.Next(wait)
		stop()
		switch {
		case err == nil:
			// The record's id goes up with it, for the cell's receipt.
			line := make([]byte, 0, len(rec.Frame)+40)
			line = append(append(append(line, `{"spoolId":"`...), rec.ID...), `",`...)
			line = append(append(line, rec.Frame[1:]...), '\n')
			if _, err := writer.Write(line); err != nil {
				return
			}
		case errors.Is(err, io.EOF):
			// Nothing waiting: a reader that has ended says why, once what it spooled has gone up.
			select {
			case <-r.done:
				if outcome := r.outcome.Load(); outcome != nil {
					_ = frames.Write(outcome)
				}
				return
			default:
			}
		default:
			c.settings.Logger.Warn("the spool could not be read", "event", "agent.spool_read_failed", "slot_id", r.slotID)
			_ = frames.Write(protocol.NewError(protocol.Internal, ""))
			return
		}
	}
}

func gapFrame(g spool.Gap) protocol.Gap {
	frame := protocol.Gap{Type: "gap", ID: g.ID, Reason: g.Reason, FromPosition: g.FromPosition, ToPosition: g.ToPosition}
	if g.Records >= 0 {
		records, changes := g.Records, g.Changes
		frame.Records, frame.Changes = &records, &changes
	}
	if !g.From.IsZero() {
		from, to := g.From, g.To
		frame.From, frame.To = &from, &to
	}
	return frame
}

// dropCapture drops the slot on the customer's database and reports it dropped, or why not.
func (c *Client) dropCapture(ctx context.Context, client *http.Client, frame protocol.Down) {
	log := c.settings.Logger.With("slot_id", frame.SlotID)
	if frame.Method == "binlog" || frame.Method == "change_tracking" || frame.Method == "mqtt" || frame.Method == "opcua" {
		// A binary log or change tracking reader, or an MQTT or OPC UA subscription, keeps nothing on the server: only the spool goes.
		if c.settings.Spool != nil {
			_ = c.settings.Spool.Remove(frame.SlotID)
		}
		log.Info("the capture was dropped", "event", "agent.cdc_dropped")
		c.reportCapture(ctx, client, frame.SlotID, protocol.Note{Type: "dropped"})
		return
	}
	var dsn string
	known := false
	if frame.Method == "logical_replication" && c.settings.ReplicationDSNs != nil {
		var err error
		if dsn, known, err = c.settings.ReplicationDSNs(frame.ConnectionID); err != nil {
			known = false
		}
	}
	if !known {
		log.Warn("this agent holds no replication login to drop the slot with", "event", "agent.cdc_drop_refused")
		c.reportCapture(ctx, client, frame.SlotID, protocol.NewError(protocol.NotConfigured, ""))
		return
	}
	dctx, cancel := context.WithTimeout(ctx, dropWithin)
	defer cancel()
	if err := cdc.DropSlot(dctx, dsn, frame.SlotName); err != nil {
		category, sqlstate := cdc.Failure(err)
		log.Warn("the replication slot was not dropped", "event", "agent.cdc_drop_failed", "category", category, "sqlstate", sqlstate)
		c.reportCapture(ctx, client, frame.SlotID, protocol.NewError(category, sqlstate))
		return
	}
	if c.settings.Spool != nil {
		_ = c.settings.Spool.Remove(frame.SlotID)
	}
	log.Info("the replication slot was dropped", "event", "agent.cdc_dropped")
	c.reportCapture(ctx, client, frame.SlotID, protocol.Note{Type: "dropped"})
}

// reportCapture sends one frame on a capture stream of its own.
func (c *Client) reportCapture(ctx context.Context, client *http.Client, slotID string, frame any) {
	var body strings.Builder
	if err := protocol.NewWriter(&body).Write(frame); err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(c.settings)+protocol.CDCPathPrefix+slotID, strings.NewReader(body.String()))
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/x-ndjson")
	res, err := client.Do(req)
	if err != nil {
		c.settings.Logger.Warn("a capture report did not reach the cell", "event", "agent.cdc_report_failed", "slot_id", slotID)
		return
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
}

// startTelemetry runs an mqtt or opcua capture (spec 20.2, 20.3, 20.6) on a capture stream of
// its own: the subscription says started once it holds, then sends messages or samples up as
// they arrive. Nothing is spooled: when the stream or the tunnel drops, the subscription ends and
// the cell leases the capture again, where it resumes from the broker's retained messages or the
// server's first notification of each item.
func (c *Client) startTelemetry(ctx context.Context, client *http.Client, frame protocol.Down) {
	log := c.settings.Logger.With("slot_id", frame.SlotID)
	configured := (frame.Method == "mqtt" && c.settings.Telemetry != nil && frame.MQTT != nil) ||
		(frame.Method == "opcua" && c.settings.Monitoring != nil && frame.OPCUA != nil)
	if !configured {
		go c.reportCapture(ctx, client, frame.SlotID, protocol.NewError(protocol.NotConfigured, ""))
		return
	}
	c.cdc.mu.Lock()
	if old := c.cdc.telemetry[frame.SlotID]; old != nil {
		old.cancel()
	}
	if len(c.cdc.readers)+len(c.cdc.telemetry) >= protocol.MaxCDCReaders {
		c.cdc.mu.Unlock()
		go c.reportCapture(ctx, client, frame.SlotID, protocol.NewError(protocol.Capacity, ""))
		return
	}
	sctx, cancel := context.WithCancel(ctx)
	sub := &subscription{cancel: cancel, done: make(chan struct{})}
	c.cdc.telemetry[frame.SlotID] = sub
	c.cdc.mu.Unlock()
	go func() {
		defer close(sub.done)
		defer cancel()
		defer func() {
			c.cdc.mu.Lock()
			if c.cdc.telemetry[frame.SlotID] == sub {
				delete(c.cdc.telemetry, frame.SlotID)
			}
			c.cdc.mu.Unlock()
		}()
		body, writer := io.Pipe()
		req, err := http.NewRequestWithContext(sctx, http.MethodPost, base(c.settings)+protocol.CDCPathPrefix+frame.SlotID, body)
		if err != nil {
			return
		}
		req.Header.Set("content-type", "application/x-ndjson")
		answered := make(chan struct{})
		go func() {
			defer close(answered)
			res, err := client.Do(req)
			if err != nil {
				_ = body.CloseWithError(err)
				cancel()
				return
			}
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			_ = body.Close()
			cancel()
		}()
		defer func() {
			_ = writer.Close()
			<-answered
		}()
		frames := protocol.NewWriter(writer)
		var mu sync.Mutex
		write := func(frame any) error {
			mu.Lock()
			defer mu.Unlock()
			return frames.Write(frame)
		}
		started := func() error { return write(protocol.Note{Type: "started"}) }
		var refusal *protocol.Error
		if frame.Method == "opcua" {
			refusal = c.settings.Monitoring.Monitor(sctx, frame.ConnectionID, frame.SlotID, frame.OPCUA, started,
				func(samples []map[string]any) error {
					return write(protocol.Samples{Type: "samples", Samples: samples})
				})
		} else {
			refusal = c.settings.Telemetry.Subscribe(sctx, frame.ConnectionID, frame.SlotID, frame.MQTT, started,
				func(messages []map[string]any) error {
					return write(protocol.Messages{Type: "messages", Messages: messages})
				})
		}
		if refusal != nil && sctx.Err() == nil {
			log.Warn("the subscription ended", "event", "agent.subscription_ended", "method", frame.Method, "category", refusal.Category)
			// A capture stream's failures are a closed set: a malformed start is the agent's internal failure.
			category := refusal.Category
			if category == protocol.Integrity {
				category = protocol.Internal
			}
			// The category alone: a capture stream's error carries no reason.
			_ = write(protocol.NewError(category, ""))
		}
	}()
}
