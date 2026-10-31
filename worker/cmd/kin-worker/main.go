package main

import (
	"log"
	"os"

	"github.com/dofastted/kin-gateway/worker/internal/oauthcmd"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "oauth" {
		log.Printf("usage: kin-worker oauth")
		os.Exit(2)
	}
	os.Exit(oauthcmd.Run(os.Args[2:], os.Stdin, os.Stdout))
}
