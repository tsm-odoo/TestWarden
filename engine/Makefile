BINARY=engine

build:
	go build -o $(BINARY) .

release:
	mkdir -p dist

	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o dist/$(BINARY)-linux-amd64 .
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o dist/$(BINARY)-linux-arm64 .

	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -o dist/$(BINARY)-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o dist/$(BINARY)-darwin-arm64 .

clean:
	rm -rf dist
