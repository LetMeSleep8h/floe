// BenchmarkLoopbackTransfer (issue #791): the engine's only Go benchmark. It
// sends 64 MiB between two Floe peers paired in one process through peer.New,
// as every real transfer is, and reports MB/s so changes to the engine's
// speed levers (chunk size, backpressure marks, per-file SHA-256 and fsync)
// or to the Go toolchain ship with a number.
//
// Run with:
//
//	go test ./engine/peer/ -bench BenchmarkLoopbackTransfer -benchtime 1x
package peer_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	transfer "github.com/jannskiee/floe/cli/engine/transfer"
)

func BenchmarkLoopbackTransfer(b *testing.B) {
	// The receiver prints its boxes to stdout, which would split Go's result
	// lines; send them to the void for the run.
	old := os.Stdout
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		b.Fatal(err)
	}
	os.Stdout = devnull
	b.Cleanup(func() {
		os.Stdout = old
		devnull.Close()
	})

	for _, bc := range []struct {
		name  string
		files int
		size  int
	}{
		{"one-64MiB", 1, 64 << 20},
		{"256x256KiB", 256, 256 << 10},
	} {
		b.Run(bc.name, func(b *testing.B) {
			host, visitor := pairHostVisitor(b, newRelay(b))
			_ = host

			src := b.TempDir()
			out := b.TempDir()
			want := make(map[string][32]byte, bc.files)
			for i := 0; i < bc.files; i++ {
				name := fmt.Sprintf("file-%03d.bin", i)
				rel := filepath.Join("payload", name)
				if err := os.MkdirAll(filepath.Dir(filepath.Join(src, rel)), 0o755); err != nil {
					b.Fatal(err)
				}
				want[rel] = writeRandom(b, src, rel, bc.size)
			}
			paths := []string{filepath.Join(src, "payload")}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				receiveErr := make(chan error, 1)
				go func() {
					receiveErr <- transfer.ReceiveFilesWithOptions(
						host.dc, out, true, "", "", transfer.ReceiveOptions{
							NoProgress: true,
							OnProgress: func(transfer.Progress) {},
						})
				}()
				b.StartTimer()

				err := transfer.SendFilesWithOptions(visitor.dc, paths, "", transfer.SendOptions{
					NoSummary:  true,
					NoProgress: true,
					OnProgress: func(transfer.Progress) {},
					Messages:   visitor.early.Msgs,
					Closed:     visitor.early.Closed,
				})
				if err != nil {
					b.Fatalf("SendFilesWithOptions: %v", err)
				}
				b.StopTimer()
				if err := <-receiveErr; err != nil {
					b.Fatalf("ReceiveFilesWithOptions: %v", err)
				}
				checkTree(b, out, want)
				b.StopTimer()
				os.RemoveAll(out)
			}
			b.StopTimer()
		})
	}
}
