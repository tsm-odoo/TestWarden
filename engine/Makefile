BINARY=engine

RELEASE_FLAGS=-trimpath -buildvcs=false -ldflags="-s -w -buildid="

build:
	go build -o $(BINARY) .

release:
	mkdir -p dist

	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build $(RELEASE_FLAGS) -o dist/$(BINARY)-linux-amd64 .
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build $(RELEASE_FLAGS) -o dist/$(BINARY)-linux-arm64 .

	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build $(RELEASE_FLAGS) -o dist/$(BINARY)-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build $(RELEASE_FLAGS) -o dist/$(BINARY)-darwin-arm64 .

clean:
	rm -rf dist
