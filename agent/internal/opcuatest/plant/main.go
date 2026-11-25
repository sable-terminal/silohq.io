// Command plant runs the OPC UA test plant (package opcuatest) for the cell's end-to-end tests:
// plant -port N [-trust-dir DIR -cert-out FILE], printing "ready" once it serves, until it is
// told to stop. With -trust-dir it is secured: it offers Basic256Sha256 beside None, trusts the
// application certificates in DIR, and writes its own certificate (PEM) to FILE.
package main

import (
	"context"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"silohq.io/agent/internal/opcuatest"
)

func main() {
	port := flag.Int("port", 4840, "the port to serve on")
	trustDir := flag.String("trust-dir", "", "secured: the directory of trusted application certificates")
	certOut := flag.String("cert-out", "", "secured: where to write the server's certificate, PEM")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var plant *opcuatest.Plant
	var err error
	if *trustDir != "" {
		plant, err = opcuatest.StartSecure(ctx, *port, *trustDir)
		if err == nil && *certOut != "" {
			err = os.WriteFile(*certOut, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: plant.Certificate}), 0o644)
		}
	} else {
		plant, err = opcuatest.Start(ctx, *port)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer plant.Close()
	fmt.Println("ready")
	// SIGUSR1 turns Pump1's motor up by 10 rpm, for a test watching a subscription.
	bump := make(chan os.Signal, 1)
	signal.Notify(bump, syscall.SIGUSR1)
	for {
		select {
		case <-ctx.Done():
			return
		case <-bump:
			plant.SetSpeed("Pump1", plant.Speed("Pump1")+10)
		}
	}
}
