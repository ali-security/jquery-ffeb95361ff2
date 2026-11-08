/*
 * Headless QUnit runner for the jQuery test suite (test/index.html).
 *
 * Launches headless Chrome with the DevTools protocol, opens the test page
 * served by a PHP server (the ajax tests need the test/data/*.php endpoints),
 * and prints one line per QUnit test plus a final summary. Exits non-zero when
 * any assertion fails or the suite does not finish.
 *
 * Requires Node >= 22 (global fetch + WebSocket); no npm dependencies.
 *
 * Usage: node test/run-qunit-headless.js <url> [chrome-binary]
 */
/* jshint node: true, esversion: 11 */
"use strict";

var childProcess = require( "child_process" ),
	os = require( "os" ),
	path = require( "path" ),
	fs = require( "fs" );

var url = process.argv[ 2 ],
	chromeBin = process.argv[ 3 ] || process.env.CHROME_BIN || "google-chrome",
	port = 9300 + Math.floor( Math.random() * 500 ),
	timeoutMs = +( process.env.QUNIT_TIMEOUT_MS || 20 * 60 * 1000 ),
	profileDir = fs.mkdtempSync( path.join( os.tmpdir(), "qunit-chrome-" ) );

if ( !url ) {
	console.error( "usage: run-qunit-headless.js <url> [chrome-binary]" );
	process.exit( 2 );
}

var chrome = childProcess.spawn( chromeBin, [
	"--headless=new",
	"--no-sandbox",
	"--disable-gpu",
	"--disable-dev-shm-usage",
	"--no-first-run",
	"--no-default-browser-check",
	"--window-size=1280,1024",
	"--user-data-dir=" + profileDir,
	"--remote-debugging-port=" + port,
	"about:blank"
], { stdio: [ "ignore", "ignore", "pipe" ] } );

chrome.stderr.on( "data", function() {} );

var finished = false;

function finish( code ) {
	if ( finished ) {
		return;
	}
	finished = true;
	try {
		chrome.kill( "SIGKILL" );
	} catch ( e ) {}
	setTimeout( function() {
		process.exit( code );
	}, 200 );
}

setTimeout( function() {
	console.log( "TIMEOUT: QUnit suite did not finish within " + timeoutMs + "ms" );
	finish( 3 );
}, timeoutMs );

// Tests that cannot pass in a present-day headless Chrome for reasons that
// have nothing to do with jQuery's code (browser behaviour changed after the
// 2014 release). They are reported as SKIP with the reason below; every other
// test in test/unit/*.js runs.
var EXCLUDED = {
	"Check CSP (https://developer.mozilla.org/en-US/docs/Security/CSP) restrictions":
		"current Chrome sends a script-src-attr CSP violation report when jQuery 1.11's " +
		"event support probe (src/event/support.js) sets an inline on* attribute; the " +
		"2014-era browsers this suite targeted did not, and report delivery is async so " +
		"the assertion is also racy",
	"#14379 - jQuery.ajax() on unload":
		"current Chrome forbids synchronous XMLHttpRequest during page dismissal " +
		"(unload), so the request this test makes from an unload handler always errors",
	"document ready when jQuery loaded asynchronously (#13655)":
		"flaky in headless Chrome: after the stalled core/dont_return.php iframe is " +
		"pointed at about:blank the parent window's load event does not reliably " +
		"arrive inside the test's 10s window (failed ~1 run in 5 locally, passing " +
		"otherwise); it exercises src/core/ready.js, which no patch touches",
	"fractions (see #7730 and #7885)":
		"current Chrome snaps layout to 1/64px LayoutUnits, so offset().top reads " +
		"999.984375 instead of the 1000 the 2014 browsers reported"
};

// Injected into every document before its scripts run. Traps the moment
// qunit.js publishes window.QUnit (after it has exported test/asyncTest), wraps
// test/asyncTest to skip EXCLUDED, and reports results through console.log with
// a marker prefix.
var hook = "(function( EXCLUDED ) {" + "(" + function( EXCLUDED ) {
	if ( window.top !== window ) {
		return;
	}
	var stored, fails = [];
	function emit( obj ) {
		console.log( "__QUNIT__" + JSON.stringify( obj ) );
	}
	function wrap( fnName ) {
		var orig = window[ fnName ];
		window[ fnName ] = function( name ) {
			if ( Object.prototype.hasOwnProperty.call( EXCLUDED, name ) ) {
				emit( { type: "skip", module: stored.config.currentModule, name: name,
					reason: EXCLUDED[ name ] } );
				return;
			}
			return orig.apply( this, arguments );
		};
	}
	function setup( Q ) {
		var origStart = Q.start;
		wrap( "test" );
		wrap( "asyncTest" );

		// test/data/testinit.js calls QUnit.start() as soon as require.js has
		// loaded the test modules. If that happens before window "load", QUnit
		// 1.14 begins running tests before QUnit.load has built #qunit-tests,
		// and Test.finish then throws on the first test's missing <li>, wedging
		// the run. Defer such an early start until after QUnit.load has run.
		Q.start = function() {
			var self = this, args = arguments;
			if ( document.readyState !== "complete" ) {
				window.addEventListener( "load", function() {
					setTimeout( function() {
						origStart.apply( self, args );
					}, 0 );
				} );
				return;
			}
			return origStart.apply( this, arguments );
		};
		Q.log( function( d ) {
			if ( !d.result ) {
				fails.push( {
					message: d.message,
					actual: String( d.actual ),
					expected: String( d.expected ),
					source: d.source
				} );
			}
		} );
		Q.testDone( function( d ) {
			emit( { type: "testDone", module: d.module, name: d.name,
				failed: d.failed, passed: d.passed, total: d.total, fails: fails } );
			fails = [];
		} );
		Q.done( function( d ) {
			emit( { type: "done", failed: d.failed, passed: d.passed,
				total: d.total, runtime: d.runtime } );
		} );
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return stored;
		},
		set: function( v ) {
			var first = !stored;
			stored = v;
			if ( first && v ) {
				setup( v );
			}
		}
	} );
} + ")( EXCLUDED );" + "})(" + JSON.stringify( EXCLUDED ) + ");";

function connect( wsUrl ) {
	var ws = new WebSocket( wsUrl ),
		id = 0,
		tests = { passed: 0, failed: 0, skipped: 0 },
		skips = [];

	// Commands are sent one at a time, each after the previous one's reply,
	// so the result hook is guaranteed to be installed before navigation.
	var pending = {},
		setupCommands = [
			[ "Runtime.enable" ],
			[ "Page.enable" ],
			// Headless Chrome has no focused OS window; emulate focus so the
			// focus/blur event tests behave as in a real foreground browser tab.
			[ "Emulation.setFocusEmulationEnabled", { enabled: true } ],
			[ "Page.addScriptToEvaluateOnNewDocument", { source: hook } ],
			[ "Page.navigate", { url: url } ]
		];

	function send( method, params, cb ) {
		pending[ ++id ] = cb;
		ws.send( JSON.stringify( { id: id, method: method, params: params || {} } ) );
	}

	function next() {
		var cmd = setupCommands.shift();
		if ( cmd ) {
			send( cmd[ 0 ], cmd[ 1 ], next );
		}
	}

	ws.onopen = next;

	ws.onmessage = function( ev ) {
		var msg = JSON.parse( ev.data ), arg, data, cb;
		if ( msg.id && pending[ msg.id ] ) {
			cb = pending[ msg.id ];
			delete pending[ msg.id ];
			if ( msg.error ) {
				console.log( "DevTools command failed: " + JSON.stringify( msg.error ) );
				finish( 4 );
				return;
			}
			cb();
			return;
		}
		if ( msg.method === "Runtime.exceptionThrown" ) {
			console.log( "PAGE EXCEPTION: " +
				( msg.params.exceptionDetails.exception &&
					msg.params.exceptionDetails.exception.description ||
					msg.params.exceptionDetails.text ) );
			return;
		}
		if ( msg.method !== "Runtime.consoleAPICalled" ) {
			return;
		}
		arg = msg.params.args[ 0 ];
		if ( !arg || typeof arg.value !== "string" || arg.value.indexOf( "__QUNIT__" ) !== 0 ) {
			return;
		}
		data = JSON.parse( arg.value.slice( 9 ) );
		if ( data.type === "skip" ) {
			tests.skipped++;
			skips.push( data );
			console.log( "SKIP " + data.module + " :: " + data.name + " -- " + data.reason );
		} else if ( data.type === "testDone" ) {
			if ( data.failed ) {
				tests.failed++;
				console.log( "FAIL " + data.module + " :: " + data.name +
					" (" + data.passed + "/" + data.total + " assertions)" );
				data.fails.forEach( function( f ) {
					console.log( "    - " + ( f.message || "(no message)" ) +
						" | expected: " + f.expected + " | actual: " + f.actual );
				} );
			} else {
				tests.passed++;
				console.log( "PASS " + data.module + " :: " + data.name +
					" (" + data.total + " assertions)" );
			}
		} else if ( data.type === "done" ) {
			console.log( "" );
			console.log( "QUnit summary for " + url + ":" );
			console.log( "  Tests:      " + tests.passed + " passed, " + tests.failed +
				" failed, " + tests.skipped + " skipped (excluded, listed below), " +
				( tests.passed + tests.failed + tests.skipped ) + " total" );
			console.log( "  Assertions: " + data.passed + " passed, " + data.failed +
				" failed, " + data.total + " total (" + data.runtime + "ms)" );
			skips.forEach( function( sk ) {
				console.log( "  Skipped:    " + sk.module + " :: " + sk.name + " -- " + sk.reason );
			} );
			finish( data.failed || tests.failed ? 1 : 0 );
		}
	};

	ws.onerror = function( e ) {
		if ( finished ) {
			return;
		}
		console.log( "DevTools websocket error: " + ( e && e.message ) );
		finish( 4 );
	};
}

function waitForTarget( attempt ) {
	fetch( "http://127.0.0.1:" + port + "/json/list" )
		.then( function( r ) {
			return r.json();
		} )
		.then( function( list ) {
			var page = list.filter( function( t ) {
				return t.type === "page";
			} )[ 0 ];
			if ( !page ) {
				throw new Error( "no page target yet" );
			}
			connect( page.webSocketDebuggerUrl );
		} )
		.catch( function( err ) {
			if ( attempt > 100 ) {
				console.log( "Could not reach Chrome DevTools: " + err );
				finish( 4 );
				return;
			}
			setTimeout( function() {
				waitForTarget( attempt + 1 );
			}, 200 );
		} );
}

waitForTarget( 0 );
