package hoot

import (
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"

	"test-warden/internal/auth"
)

type TestMeta struct {
	Name string   `json:"name"`
	Tags []string `json:"tags"`
}

type SuiteMeta struct {
	Name   string `json:"name"`
	Weight int    `json:"weight"`
}

type SuiteTest struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Tags []string `json:"tags"`
}

type Metadata struct {
	TestByID       map[string]TestMeta    `json:"testById"`
	SuiteByID      map[string]SuiteMeta   `json:"suiteById"`
	TestsBySuiteID map[string][]SuiteTest `json:"testsBySuiteId"`
}

const getMetadataJSFunc = `() => {
	function getAllTests(suite) {
		const out = [];
		for (const job of suite.jobs ?? []) {
			if (job.constructor.name !== "Suite") {
				out.push({ id: job.id, name: job.name, tags: job.tags.map(t => t.id) });
			} else {
				out.push(...getAllTests(job));
			}
		}
		return out;
	}
	// __debug__ is a function on some Hoot versions and a getter on others; try calling it
	// first and fall back to plain property access if it isn't callable.
	function getHootDebug(hoot) {
		try {
			return hoot.__debug__();
		} catch (e) {
			return hoot.__debug__;
		}
	}
	const hoot = window.odoo.loader.modules.get("@web/../lib/hoot/hoot");
	const { tests, suites } = getHootDebug(hoot);
	const testById = {}, suiteById = {}, testsBySuiteId = {};
	for (const { id, fullName, tags } of tests.values()) {
		testById[id] = { name: fullName, tags: tags.map(t => t.id) };
	}
	for (const suite of suites.values()) {
		const { id, fullName, weight } = suite;
		suiteById[id] = { name: fullName, weight };
		testsBySuiteId[id] = getAllTests(suite);
	}
	return { testById, suiteById, testsBySuiteId };
}`

// Fetch opens a page, sets the auth cookie, navigates to metaURL, waits for Hoot to
// initialise, evaluates and returns the test metadata then close the page.
func Fetch(browser *rod.Browser, metaURL string, cookie *auth.Cookie) (*Metadata, error) {
	page, err := browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("create page: %w", err)
	}
	defer page.Close()
	if err := (proto.NetworkSetCookies{
		Cookies: []*proto.NetworkCookieParam{{
			Name:   cookie.Name,
			Value:  cookie.Value,
			Domain: cookie.Domain,
			Path:   "/",
		}},
	}.Call(page)); err != nil {
		return nil, fmt.Errorf("set cookie: %w", err)
	}
	// Enable Runtime to receive exception events before navigating.
	if err := (proto.RuntimeEnable{}.Call(page)); err != nil {
		return nil, fmt.Errorf("enable runtime: %w", err)
	}
	// Capture the first unhandled exception or console.error; a non-nil pointer means abort.
	var globalErr atomic.Pointer[string]
	go page.EachEvent(
		func(consoleEvent *proto.RuntimeConsoleAPICalled) bool {
			if consoleEvent.Type != proto.RuntimeConsoleAPICalledTypeError {
				return false
			}
			msg := ArgsToText(consoleEvent.Args)
			globalErr.CompareAndSwap(nil, &msg)
			return false
		},
		func(runtimeException *proto.RuntimeExceptionThrown) bool {
			msg := runtimeException.ExceptionDetails.Text
			if runtimeException.ExceptionDetails.Exception != nil && runtimeException.ExceptionDetails.Exception.Description != "" {
				msg = runtimeException.ExceptionDetails.Exception.Description
			}
			globalErr.CompareAndSwap(nil, &msg)
			return false
		},
	)()

	if err := page.Navigate(metaURL); err != nil {
		return nil, fmt.Errorf("navigate: %w", err)
	}
	// Poll until Hoot has discovered at least one test (tests.size > 0), fail fast if a
	// global JS exception fires.
	deadline := time.Now().Add(60 * time.Second)
	for {
		if errMsg := globalErr.Load(); errMsg != nil {
			return nil, fmt.Errorf("global JS error prevented Hoot from loading: %s", *errMsg)
		}
		res, err := page.Eval(`() => {
			const h = window.odoo?.loader?.modules?.get("@web/../lib/hoot/hoot");
			if (!h) return 0;
			let debug;
			try {
				debug = h.__debug__();
			} catch (e) {
				debug = h.__debug__;
			}
			return debug.tests.size;
		}`)
		if err == nil && res.Value.Num() > 0 {
			break
		}
		if time.Now().After(deadline) {
			if errMsg := globalErr.Load(); errMsg != nil {
				return nil, fmt.Errorf("global JS error prevented Hoot from loading: %s", *errMsg)
			}
			return nil, fmt.Errorf("timeout waiting for Hoot to register tests")
		}
		time.Sleep(25 * time.Millisecond)
	}
	res, err := page.Eval(getMetadataJSFunc)
	if err != nil {
		return nil, fmt.Errorf("could not fetch metadata: %w", err)
	}
	raw, err := json.Marshal(res.Value)
	if err != nil {
		return nil, fmt.Errorf("marshal metadata: %w", err)
	}
	var meta Metadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, fmt.Errorf("parse metadata: %w", err)
	}
	return &meta, nil
}
