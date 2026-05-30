//#region src/helpers.ts
/**
* SGR probe — feed SGR sequence + "X", verify cell attribute (termless) or cursor position (term).
*
* Termless: check that the SGR sequence is parsed and applied to the cell.
* Term: check that the SGR sequence is consumed (cursor advances by 1 char, not printed literally).
*/
function sgrProbe(id, sequence, check) {
	return {
		id,
		termless(ctx) {
			ctx.feed(sequence + "X");
			return { pass: check(ctx.getCell(0, 0)) };
		},
		async term(ctx) {
			ctx.write("\x1B[1;1H\x1B[2K");
			ctx.write(sequence + "X\x1B[0m");
			const pos = await ctx.queryCursorPosition();
			if (!pos) return {
				pass: false,
				note: "No cursor response"
			};
			return {
				pass: pos.col === 2,
				note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
			};
		}
	};
}
/**
* Cursor probe — move cursor, verify position.
* Termless uses 0-based coordinates, term DSR uses 1-based.
*/
function cursorProbe(id, setup, move, expected) {
	return {
		id,
		termless(ctx) {
			ctx.feed(setup + move);
			const cursor = ctx.getCursor();
			return {
				pass: cursor.x === expected.col && cursor.y === expected.row,
				note: cursor.x === expected.col && cursor.y === expected.row ? void 0 : `got ${cursor.y};${cursor.x}, expected ${expected.row};${expected.col}`
			};
		},
		async term(ctx) {
			ctx.write(setup);
			ctx.write(move);
			const pos = await ctx.queryCursorPosition();
			if (!pos) return {
				pass: false,
				note: "No cursor response"
			};
			const expRow = expected.row + 1;
			const expCol = expected.col + 1;
			return {
				pass: pos.row === expRow && pos.col === expCol,
				note: pos.row === expRow && pos.col === expCol ? void 0 : `got ${pos.row};${pos.col}, expected ${expRow};${expCol}`,
				response: `${pos.row};${pos.col}`
			};
		}
	};
}
/**
* Mode probe — check mode via getMode (termless) or DECRPM (term).
*/
function modeProbe(id, modeName, enableSeq, _disableSeq, modeNum) {
	return {
		id,
		termless(ctx) {
			ctx.feed(enableSeq);
			return { pass: ctx.getMode(modeName) === true };
		},
		async term(ctx) {
			const result = await ctx.queryMode(modeNum);
			if (result === null) return {
				pass: false,
				note: "No DECRPM response"
			};
			return {
				pass: result !== "unknown",
				note: result === "unknown" ? "Mode not recognized" : `Mode ${result}`,
				response: result
			};
		}
	};
}
/**
* Behavioral mode probe — enable mode, verify terminal is responsive, disable.
* Uses DECRPM first (term), falls back to behavioral test.
*/
function behavioralModeProbe(id, enableSeq, disableSeq, modeNum, termlessFn, termBehaviorFn) {
	return {
		id,
		termless: termlessFn,
		async term(ctx) {
			const decrpmResult = await ctx.queryMode(modeNum);
			if (decrpmResult !== null && decrpmResult !== "unknown") return {
				pass: true,
				note: `DECRPM: mode ${decrpmResult}`,
				response: decrpmResult
			};
			ctx.write(enableSeq);
			const result = termBehaviorFn ? await termBehaviorFn(ctx) : await defaultBehaviorTest(ctx);
			ctx.write(disableSeq);
			return result;
		}
	};
}
async function defaultBehaviorTest(ctx) {
	const pos = await ctx.queryCursorPosition();
	return {
		pass: pos !== null,
		note: pos ? "Behavioral: responsive after enable" : "No response"
	};
}
/**
* Response probe — send query, check response via feedCapture (termless) or query (term).
*/
function responseProbe(id, sequence, expectedPattern, termlessCheck, termQueryFn) {
	return {
		id,
		termless(ctx) {
			const response = ctx.feedCapture(sequence);
			if (termlessCheck) return termlessCheck(response);
			return {
				pass: expectedPattern.test(response),
				note: expectedPattern.test(response) ? void 0 : `Response: ${JSON.stringify(response)}`,
				response
			};
		},
		term: termQueryFn ?? null
	};
}
/**
* Capability probe — check capabilities flag (termless only, term=null).
*/
function capabilityProbe(id, capName) {
	return {
		id,
		termless(ctx) {
			return { pass: ctx.capabilities[capName] === true };
		},
		term: null
	};
}
/**
* Width probe — check rendered width of text.
*/
function widthProbe(id, text, expectedWidth) {
	return {
		id,
		termless(ctx) {
			ctx.feed(text + "X");
			const cell = ctx.getCell(0, expectedWidth);
			return {
				pass: cell.char === "X",
				note: cell.char === "X" ? void 0 : `char at col ${expectedWidth} is "${cell.char}", expected "X"`
			};
		},
		async term(ctx) {
			const width = await ctx.measureRenderedWidth(text);
			if (width === null) return {
				pass: false,
				note: "Cannot measure width"
			};
			return {
				pass: width === expectedWidth,
				note: width === expectedWidth ? void 0 : `width=${width}, expected ${expectedWidth}`
			};
		}
	};
}
/** Check if a cell character is blank (empty or space). */
function isBlank(char) {
	return char === "" || char === " ";
}
/**
* Simple probe — for probes that need custom logic on both sides.
*/
function probe(id, termless, term) {
	return {
		id,
		termless,
		term
	};
}
//#endregion
//#region src/sgr.ts
const sgrProbes = [
	sgrProbe("sgr.bold", "\x1B[1m", (cell) => cell.bold === true),
	sgrProbe("sgr.faint", "\x1B[2m", (cell) => cell.dim === true),
	sgrProbe("sgr.italic", "\x1B[3m", (cell) => cell.italic === true),
	sgrProbe("sgr.underline.single", "\x1B[4m", (cell) => !!cell.underline),
	sgrProbe("sgr.underline.double", "\x1B[21m", (cell) => cell.underline === "double"),
	sgrProbe("sgr.underline.curly", "\x1B[4:3m", (cell) => cell.underline === "curly"),
	sgrProbe("sgr.underline.dotted", "\x1B[4:4m", (cell) => cell.underline === "dotted"),
	sgrProbe("sgr.underline.dashed", "\x1B[4:5m", (cell) => cell.underline === "dashed"),
	sgrProbe("sgr.blink", "\x1B[5m", (cell) => cell.blink === true),
	sgrProbe("sgr.inverse", "\x1B[7m", (cell) => cell.inverse === true),
	sgrProbe("sgr.hidden", "\x1B[8m", (cell) => cell.hidden === true),
	sgrProbe("sgr.strikethrough", "\x1B[9m", (cell) => cell.strikethrough === true),
	sgrProbe("sgr.overline", "\x1B[53m", (cell) => cell.overline === true || cell.overline === void 0),
	probe("sgr.underline.color", (ctx) => {
		ctx.feed("\x1B[4m\x1B[58;2;255;0;128mX");
		const cell = ctx.getCell(0, 0);
		if (!cell.underline) return {
			pass: false,
			note: "underline not set"
		};
		if (!cell.underlineColor) return {
			pass: false,
			note: "underlineColor not set"
		};
		return { pass: cell.underlineColor.r === 255 && cell.underlineColor.g === 0 && cell.underlineColor.b === 128 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[4m\x1B[58;2;255;0;0mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.underline-color-indexed", (ctx) => {
		ctx.feed("\x1B[4m\x1B[58;5;5mX");
		const cell = ctx.getCell(0, 0);
		if (!cell.underline) return {
			pass: false,
			note: "underline not set"
		};
		if (cell.underlineColor === void 0) return {
			pass: true,
			note: "underlineColor not tracked by backend"
		};
		if (cell.underlineColor === null) return {
			pass: false,
			note: "underlineColor is null after SGR 58;5;5"
		};
		const c = cell.underlineColor;
		const looksColored = c.r > 0 || c.g > 0 || c.b > 0;
		return {
			pass: looksColored,
			note: looksColored ? void 0 : `underlineColor is rgb(${c.r},${c.g},${c.b})`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[4m\x1B[58;5;5mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.underline-color-rgb", (ctx) => {
		ctx.feed("\x1B[4m\x1B[58;2;255;0;128mX");
		const cell = ctx.getCell(0, 0);
		if (!cell.underline) return {
			pass: false,
			note: "underline not set"
		};
		if (cell.underlineColor === void 0) return {
			pass: true,
			note: "underlineColor not tracked by backend"
		};
		if (cell.underlineColor === null) return {
			pass: false,
			note: "underlineColor is null after SGR 58;2;255;0;128"
		};
		const c = cell.underlineColor;
		const matches = c.r === 255 && c.g === 0 && c.b === 128;
		return {
			pass: matches,
			note: matches ? void 0 : `underlineColor is rgb(${c.r},${c.g},${c.b}), expected rgb(255,0,128)`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[4m\x1B[58;2;255;0;128mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.underline-color-reset", (ctx) => {
		ctx.feed("\x1B[4m\x1B[58;2;255;0;128mX\x1B[59mY");
		const cell = ctx.getCell(0, 1);
		if (!cell.underline) return {
			pass: false,
			note: "underline not set on cell 1"
		};
		if (cell.underlineColor === void 0) return {
			pass: true,
			note: "underlineColor not tracked by backend"
		};
		const c = cell.underlineColor;
		if (c === null) return { pass: true };
		const stillColored = c.r === 255 && c.g === 0 && c.b === 128;
		return {
			pass: !stillColored,
			note: stillColored ? "underlineColor still rgb(255,0,128) after SGR 59 — reset not honored" : `underlineColor is rgb(${c.r},${c.g},${c.b}) after SGR 59`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[4m\x1B[58;2;255;0;128m\x1B[59mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.fg.standard", (ctx) => {
		ctx.feed("\x1B[31mX");
		const fg = ctx.getCell(0, 0).fg;
		if (!fg) return {
			pass: false,
			note: "fg is null"
		};
		return { pass: fg.r > 100 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[31mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.bg.standard", (ctx) => {
		ctx.feed("\x1B[42mX");
		const bg = ctx.getCell(0, 0).bg;
		if (!bg) return {
			pass: false,
			note: "bg is null"
		};
		return { pass: bg.g > 100 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[41mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.fg.bright", (ctx) => {
		ctx.feed("\x1B[91mX");
		const fg = ctx.getCell(0, 0).fg;
		if (!fg) return {
			pass: false,
			note: "fg is null"
		};
		return { pass: fg.r > 150 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[91mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.bg.bright", (ctx) => {
		ctx.feed("\x1B[102mX");
		const bg = ctx.getCell(0, 0).bg;
		if (!bg) return {
			pass: false,
			note: "bg is null"
		};
		return { pass: bg.g > 150 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[101mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.fg.default", (ctx) => {
		ctx.feed("\x1B[31mX\x1B[39mY");
		return { pass: ctx.getCell(0, 1).fg === null };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[39mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.bg.default", (ctx) => {
		ctx.feed("\x1B[42mX\x1B[49mY");
		return { pass: ctx.getCell(0, 1).bg === null };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[49mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.fg.256", (ctx) => {
		ctx.feed("\x1B[38;5;196mX");
		const fg = ctx.getCell(0, 0).fg;
		if (!fg) return {
			pass: false,
			note: "fg is null"
		};
		return { pass: fg.r > 200 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[38;5;196mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.bg.256", (ctx) => {
		ctx.feed("\x1B[48;5;21mX");
		const bg = ctx.getCell(0, 0).bg;
		if (!bg) return {
			pass: false,
			note: "bg is null"
		};
		return { pass: bg.b > 100 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[48;5;21mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.fg.truecolor", (ctx) => {
		ctx.feed("\x1B[38;2;255;128;0mX");
		const fg = ctx.getCell(0, 0).fg;
		if (!fg) return {
			pass: false,
			note: "fg is null"
		};
		return { pass: fg.r === 255 && fg.g === 128 && fg.b === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[38;2;255;0;128mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.bg.truecolor", (ctx) => {
		ctx.feed("\x1B[48;2;0;255;128mX");
		const bg = ctx.getCell(0, 0).bg;
		if (!bg) return {
			pass: false,
			note: "bg is null"
		};
		return { pass: bg.r === 0 && bg.g === 255 && bg.b === 128 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[48;2;0;255;64mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.selective-reset.bold", (ctx) => {
		ctx.feed("\x1B[1mX\x1B[22mY");
		const cell = ctx.getCell(0, 1);
		return { pass: cell.bold === false && cell.dim === false };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[1m\x1B[22mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.selective-reset.underline", (ctx) => {
		ctx.feed("\x1B[4mX\x1B[24mY");
		return { pass: !ctx.getCell(0, 1).underline };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[4m\x1B[24mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.selective-reset.italic", (ctx) => {
		ctx.feed("\x1B[3mX\x1B[23mY");
		return { pass: ctx.getCell(0, 1).italic === false };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[3m\x1B[23mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.selective-reset.inverse", (ctx) => {
		ctx.feed("\x1B[7mX\x1B[27mY");
		return { pass: ctx.getCell(0, 1).inverse === false };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[7m\x1B[27mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("sgr.reset", (ctx) => {
		ctx.feed("\x1B[1;3;4mX\x1B[0mY");
		const cell = ctx.getCell(0, 1);
		return { pass: cell.bold === false && cell.italic === false && !cell.underline };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[1m\x1B[0mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	})
];
//#endregion
//#region src/cursor.ts
const cursorProbes = [
	cursorProbe("cursor.move.absolute", "", "\x1B[5;10H", {
		row: 4,
		col: 9
	}),
	cursorProbe("cursor.move.home", "ABC", "\x1B[H", {
		row: 0,
		col: 0
	}),
	cursorProbe("cursor.move.forward", "", "\x1B[5C", {
		row: 0,
		col: 5
	}),
	cursorProbe("cursor.move.back", "ABC", "\x1B[2D", {
		row: 0,
		col: 1
	}),
	cursorProbe("cursor.move.down", "", "\x1B[3B", {
		row: 3,
		col: 0
	}),
	cursorProbe("cursor.move.up", "\x1B[5B", "\x1B[2A", {
		row: 3,
		col: 0
	}),
	probe("cursor.hide", (ctx) => {
		ctx.feed("\x1B[?25l");
		return { pass: ctx.getCursor().visible === false };
	}, async (ctx) => {
		ctx.write("\x1B[?25l");
		const posHidden = await ctx.queryCursorPosition();
		ctx.write("\x1B[?25h");
		if (!posHidden) return {
			pass: false,
			note: "No cursor response while hidden"
		};
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response after show"
		};
		return { pass: true };
	}),
	probe("cursor.shape", (ctx) => {
		ctx.feed("\x1B[6 q");
		const style = ctx.getCursor().style;
		return { pass: style === "beam" || style === null };
	}, async (ctx) => {
		ctx.write("\x1B[5 q");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[0 q");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No response after DECSCUSR"
		};
	}),
	probe("cursor.horizontal-absolute", (ctx) => {
		ctx.feed("ABCDE\x1B[3G");
		return { pass: ctx.getCursor().x === 2 };
	}, async (ctx) => {
		ctx.write("\x1B[3;1H");
		ctx.write("\x1B[15G");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 3 && pos.col === 15,
			note: pos.row === 3 && pos.col === 15 ? void 0 : `got ${pos.row};${pos.col}, expected 3;15`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.next-line", (ctx) => {
		ctx.feed("ABC\x1B[2E");
		return { pass: ctx.getCursor().y === 2 && ctx.getCursor().x === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B[E");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 4 && pos.col === 1,
			note: pos.row === 4 && pos.col === 1 ? void 0 : `got ${pos.row};${pos.col}, expected 4;1`
		};
	}),
	probe("cursor.position-report", (ctx) => {
		ctx.feed("\x1B[3;5H");
		const response = ctx.feedCapture("\x1B[6n");
		return {
			pass: response.includes("3;5R"),
			response
		};
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No DSR 6 response"
		};
		return {
			pass: pos.row === 3 && pos.col === 5,
			note: pos.row === 3 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 3;5`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.ansi-save", (ctx) => {
		ctx.feed("\x1B[3;5H");
		ctx.feed("\x1B[s");
		ctx.feed("\x1B[10;15H");
		ctx.feed("\x1B[u");
		const cursor = ctx.getCursor();
		const pass = cursor.y === 2 && cursor.x === 4;
		return {
			pass,
			note: pass ? void 0 : `cursor at ${cursor.y};${cursor.x}, expected 2;4 after CSI s/u`
		};
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B[s");
		ctx.write("\x1B[10;15H");
		ctx.write("\x1B[u");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after restore"
		};
		return {
			pass: pos.row === 3 && pos.col === 5,
			note: pos.row === 3 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 3;5`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.ansi-restore", (ctx) => {
		ctx.feed("\x1B[4;6H");
		ctx.feed("\x1B[s");
		ctx.feed("\x1B[12;18H");
		ctx.feed("\x1B[u");
		const cursor = ctx.getCursor();
		const pass = cursor.y === 3 && cursor.x === 5;
		return {
			pass,
			note: pass ? void 0 : `cursor at ${cursor.y};${cursor.x}, expected 3;5 after CSI u`
		};
	}, async (ctx) => {
		ctx.write("\x1B[4;6H");
		ctx.write("\x1B[s");
		ctx.write("\x1B[12;18H");
		ctx.write("\x1B[u");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after restore"
		};
		return {
			pass: pos.row === 4 && pos.col === 6,
			note: pos.row === 4 && pos.col === 6 ? void 0 : `got ${pos.row};${pos.col}, expected 4;6`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.save-restore", (ctx) => {
		ctx.feed("AB\x1B7\x1B[5;5H\x1B8");
		return { pass: ctx.getCursor().x === 2 && ctx.getCursor().y === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B7");
		ctx.write("\x1B[10;10H");
		ctx.write("\x1B8");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after restore"
		};
		return {
			pass: pos.row === 3 && pos.col === 5,
			note: pos.row === 3 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 3;5`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.reverse-wrap", (ctx) => {
		ctx.feed("\x1B[?7h");
		ctx.feed("\x1B[?45h");
		const cols = 80;
		ctx.feed("A".repeat(cols));
		ctx.feed("\b");
		const cursor = ctx.getCursor();
		ctx.feed("\x1B[?45l");
		return {
			pass: cursor.y === 0 && cursor.x === cols - 1,
			note: cursor.y === 0 ? void 0 : `cursor at ${cursor.x},${cursor.y}, expected ${cols - 1},0`
		};
	}, async (ctx) => {
		ctx.write("\x1B[?45h");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?45l");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after enabling reverse wrap"
		};
	}),
	probe("cursor.cup-boundaries", (ctx) => {
		ctx.feed("\x1B[999;999H");
		const cursor = ctx.getCursor();
		return {
			pass: cursor.y === 23 && cursor.x === 79,
			note: cursor.y === 23 && cursor.x === 79 ? void 0 : `got ${cursor.y};${cursor.x}, expected 23;79`
		};
	}, async (ctx) => {
		ctx.write("\x1B[999;999H");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row <= 24 && pos.col <= 80 && pos.row > 0 && pos.col > 0,
			note: pos.row <= 24 && pos.col <= 80 && pos.row > 0 && pos.col > 0 ? void 0 : `got ${pos.row};${pos.col}, expected within screen bounds`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.cuu-past-top", (ctx) => {
		ctx.feed("\x1B[4;1H");
		ctx.feed("\x1B[999A");
		return {
			pass: ctx.getCursor().y === 0,
			note: ctx.getCursor().y === 0 ? void 0 : `got row ${ctx.getCursor().y}, expected 0`
		};
	}, async (ctx) => {
		ctx.write("\x1B[4;1H");
		ctx.write("\x1B[999A");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 1,
			note: pos.row === 1 ? void 0 : `got row ${pos.row}, expected 1`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.cud-past-bottom", (ctx) => {
		ctx.feed("\x1B[1;1H");
		ctx.feed("\x1B[999B");
		return {
			pass: ctx.getCursor().y === 23,
			note: ctx.getCursor().y === 23 ? void 0 : `got row ${ctx.getCursor().y}, expected 23`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[999B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row >= 20,
			note: `cursor at row ${pos.row}`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.vpa", (ctx) => {
		ctx.feed("\x1B[3;5H");
		ctx.feed("\x1B[10d");
		const cursor = ctx.getCursor();
		return {
			pass: cursor.y === 9 && cursor.x === 4,
			note: cursor.y === 9 && cursor.x === 4 ? void 0 : `got ${cursor.y};${cursor.x}, expected 9;4`
		};
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B[10d");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 10 && pos.col === 5,
			note: pos.row === 10 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 10;5`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.cpl", (ctx) => {
		ctx.feed("\x1B[6;10H");
		ctx.feed("\x1B[2F");
		const cursor = ctx.getCursor();
		return {
			pass: cursor.y === 3 && cursor.x === 0,
			note: cursor.y === 3 && cursor.x === 0 ? void 0 : `got ${cursor.y};${cursor.x}, expected 3;0`
		};
	}, async (ctx) => {
		ctx.write("\x1B[6;10H");
		ctx.write("\x1B[2F");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 4 && pos.col === 1,
			note: pos.row === 4 && pos.col === 1 ? void 0 : `got ${pos.row};${pos.col}, expected 4;1`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.hpa", (ctx) => {
		ctx.feed("ABCDEFGH\x1B[5`");
		return { pass: ctx.getCursor().x === 4 };
	}, async (ctx) => {
		ctx.write("\x1B[3;1H");
		ctx.write("\x1B[15`");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 3 && pos.col === 15,
			note: pos.row === 3 && pos.col === 15 ? void 0 : `got ${pos.row};${pos.col}, expected 3;15`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("cursor.cup-scroll-region", (ctx) => {
		ctx.feed("\x1B[5;15r");
		ctx.feed("\x1B[?6h");
		ctx.feed("\x1B[1;1H");
		const cursor = ctx.getCursor();
		const pass = cursor.y === 4 && cursor.x === 0;
		ctx.feed("\x1B[?6l");
		ctx.feed("\x1B[r");
		return {
			pass,
			note: pass ? void 0 : `got ${cursor.y};${cursor.x}, expected 4;0`
		};
	}, async (ctx) => {
		ctx.write("\x1B[5;15r");
		ctx.write("\x1B[?6h");
		ctx.write("\x1B[1;1H");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?6l");
		ctx.write("\x1B[r");
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 5 && pos.col === 1,
			note: pos.row === 5 && pos.col === 1 ? void 0 : `got ${pos.row};${pos.col}, expected 5;1`,
			response: `${pos.row};${pos.col}`
		};
	})
];
//#endregion
//#region src/text.ts
const textProbes = [
	probe("text.basic", (ctx) => {
		ctx.feed("Hello");
		return { pass: ctx.getText().includes("Hello") };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("Hello");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 6,
			note: pos.col === 6 ? void 0 : `cursor at col ${pos.col}, expected 6`
		};
	}),
	probe("text.newline", (ctx) => {
		ctx.feed("A\r\nB");
		return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(1, 0).char === "B" };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\n");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 4,
			note: pos.row === 4 ? void 0 : `cursor at row ${pos.row}, expected 4`
		};
	}),
	probe("text.wrap", (ctx) => {
		ctx.feed("X".repeat(85));
		return { pass: ctx.getCell(1, 0).char === "X" };
	}, async (ctx) => {
		const cols = ctx.cols;
		ctx.write("\x1B[1;1H\x1B[2K");
		const line = "W".repeat(cols) + "X";
		ctx.write(line);
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 2 && pos.col === 2,
			note: pos.row === 2 && pos.col === 2 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 2;2`
		};
	}),
	probe("text.tab", (ctx) => {
		ctx.feed("	X");
		return { pass: ctx.getCell(0, 8).char === "X" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("	");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 9,
			note: pos.col === 9 ? void 0 : `cursor at col ${pos.col}, expected 9`
		};
	}),
	probe("text.wide.emoji", (ctx) => {
		ctx.feed("🎉");
		return { pass: ctx.getCell(0, 0).wide === true };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("😀");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	}),
	probe("text.wide.cjk", (ctx) => {
		ctx.feed("中");
		return { pass: ctx.getCell(0, 0).wide === true };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("中");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	}),
	probe("text.overwrite", (ctx) => {
		ctx.feed("AB\x1B[1GC");
		return { pass: ctx.getCell(0, 0).char === "C" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("AB");
		ctx.write("\x1B[1;2H");
		ctx.write("X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 3,
			note: pos.col === 3 ? void 0 : `cursor at col ${pos.col}, expected 3`
		};
	}),
	probe("text.cr", (ctx) => {
		ctx.feed("AB\rC");
		return { pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "B" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("AB");
		ctx.write("\r");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("text.backspace", (ctx) => {
		ctx.feed("AB\bC");
		return { pass: ctx.getCell(0, 0).char === "A" && ctx.getCell(0, 1).char === "C" };
	}, async (ctx) => {
		ctx.write("\x1B[1;5H");
		ctx.write("\b");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 4,
			note: pos.col === 4 ? void 0 : `cursor at col ${pos.col}, expected 4`
		};
	}),
	probe("text.index", (ctx) => {
		ctx.feed("A\x1BD");
		return { pass: ctx.getCursor().y === 1 };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1BD");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 4 && pos.col === 5,
			note: pos.row === 4 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 4;5`
		};
	}),
	probe("text.next-line", (ctx) => {
		ctx.feed("ABC\x1BE");
		return { pass: ctx.getCursor().y === 1 && ctx.getCursor().x === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1BE");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 4 && pos.col === 1,
			note: pos.row === 4 && pos.col === 1 ? void 0 : `got ${pos.row};${pos.col}, expected 4;1`
		};
	}),
	probe("text.reverse-index-scroll", (ctx) => {
		ctx.feed("\x1B[1;5r");
		ctx.feed("\x1B[H");
		ctx.feed("MARKER");
		ctx.feed("\x1B[H");
		ctx.feed("\x1BM");
		const cell = ctx.getCell(1, 0);
		ctx.feed("\x1B[r");
		return {
			pass: cell.char === "M",
			note: cell.char === "M" ? void 0 : `row 1 char='${cell.char}', expected 'M' (MARKER shifted down)`
		};
	}, async (ctx) => {
		ctx.write("\x1B[3;10r");
		ctx.write("\x1B[3;1H");
		ctx.write("\x1BM");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[r");
		if (!pos) return {
			pass: false,
			note: "No cursor response after RI in region"
		};
		return {
			pass: pos.row === 3,
			note: pos.row === 3 ? void 0 : `cursor at row ${pos.row}, expected 3`
		};
	}),
	probe("text.combining", (ctx) => {
		ctx.feed("éX");
		return { pass: ctx.getCell(0, 1).char === "X" };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("é");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 1,
			note: width === 1 ? void 0 : `width=${width}, expected 1`
		};
	}),
	probe("text.hts", (ctx) => {
		ctx.feed("\x1B[3g");
		ctx.feed("\x1B[6G");
		ctx.feed("\x1BH");
		ctx.feed("\x1B[1G");
		ctx.feed("	");
		return {
			pass: ctx.getCursor().x === 5,
			note: ctx.getCursor().x === 5 ? void 0 : `cursor at col ${ctx.getCursor().x}, expected 5`
		};
	}, async (ctx) => {
		ctx.write("\x1B[3g");
		ctx.write("\x1B[1;6H");
		ctx.write("\x1BH");
		ctx.write("\x1B[1;1H");
		ctx.write("	");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 6,
			note: pos.col === 6 ? void 0 : `cursor at col ${pos.col}, expected 6`
		};
	}),
	probe("text.tbc", (ctx) => {
		ctx.feed("\x1B[3g");
		ctx.feed("	");
		return {
			pass: ctx.getCursor().x === 0,
			note: ctx.getCursor().x === 0 ? void 0 : `cursor at col ${ctx.getCursor().x}, expected 0`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[3g");
		ctx.write("	");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("text.cht", (ctx) => {
		ctx.feed("\x1B[2I");
		return {
			pass: ctx.getCursor().x === 16,
			note: ctx.getCursor().x === 16 ? void 0 : `cursor at col ${ctx.getCursor().x}, expected 16`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[2I");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 17,
			note: pos.col === 17 ? void 0 : `cursor at col ${pos.col}, expected 17`
		};
	}),
	probe("text.cbt", (ctx) => {
		ctx.feed("\x1B[21G");
		ctx.feed("\x1B[Z");
		return {
			pass: ctx.getCursor().x === 16,
			note: ctx.getCursor().x === 16 ? void 0 : `cursor at col ${ctx.getCursor().x}, expected 16`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;21H");
		ctx.write("\x1B[Z");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 17,
			note: pos.col === 17 ? void 0 : `cursor at col ${pos.col}, expected 17`
		};
	}),
	probe("text.wide.emoji-flags", (ctx) => {
		ctx.feed("🇺🇸X");
		return { pass: ctx.getCell(0, 0).wide === true };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("🇺🇸");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	}),
	probe("text.wide.emoji-vs16", (ctx) => {
		ctx.feed("☺️X");
		return { pass: ctx.getCell(0, 0).wide === true };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("☺️");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	}),
	probe("text.wide.emoji-zwj", (ctx) => {
		ctx.feed("👨‍👩‍👧X");
		return { pass: ctx.getText().includes("X") };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("👨‍👩‍👧‍👦");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	})
];
//#endregion
//#region src/erase.ts
const eraseProbes = [
	probe("erase.line.right", (ctx) => {
		ctx.feed("XXXXX\x1B[1G\x1B[K");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCDE");
		ctx.write("\x1B[1;3H");
		ctx.write("\x1B[0K");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 3,
			note: pos.col === 3 ? void 0 : `cursor at col ${pos.col}, expected 3`
		};
	}),
	probe("erase.line.left", (ctx) => {
		ctx.feed("XXXXX\x1B[3G\x1B[1K");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCDE");
		ctx.write("\x1B[1;3H");
		ctx.write("\x1B[1K");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 3,
			note: pos.col === 3 ? void 0 : `cursor at col ${pos.col}, expected 3`
		};
	}),
	probe("erase.line.all", (ctx) => {
		ctx.feed("XXXXX\x1B[2K");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCDE");
		ctx.write("\x1B[1;3H");
		ctx.write("\x1B[2K");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 3,
			note: pos.col === 3 ? void 0 : `cursor at col ${pos.col}, expected 3`
		};
	}),
	probe("erase.screen.below", (ctx) => {
		ctx.feed("AAA\r\nBBB\r\nCCC\x1B[H\x1B[J");
		return { pass: !ctx.getText().includes("BBB") };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[0J");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after ED 0"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("erase.screen.above", (ctx) => {
		ctx.feed("AAA\r\nBBB\r\nCCC\x1B[3;2H\x1B[1J");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[1J");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after ED 1"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("erase.screen.all", (ctx) => {
		ctx.feed("AAA\r\nBBB\r\nCCC\x1B[2J");
		return { pass: ctx.getText().trim() === "" };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[2J");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after ED 2"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("erase.screen.scrollback", (ctx) => {
		for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`);
		ctx.feed("\x1B[3J");
		const scroll = ctx.getScrollback();
		return { pass: scroll.totalLines <= scroll.screenLines };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[3J");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after ED 3"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("erase.character", (ctx) => {
		ctx.feed("ABCDE\x1B[1G\x1B[3X");
		return { pass: isBlank(ctx.getCell(0, 0).char) && isBlank(ctx.getCell(0, 1).char) && isBlank(ctx.getCell(0, 2).char) && ctx.getCell(0, 3).char === "D" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCD");
		ctx.write("\x1B[1;2H");
		ctx.write("\x1B[2X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("erase.selective", (ctx) => {
		ctx.feed("ABCDE");
		ctx.feed("\x1B[H");
		ctx.feed("\x1B[?2J");
		const cell = ctx.getCell(0, 0);
		return {
			pass: isBlank(cell.char),
			note: isBlank(cell.char) ? void 0 : `cell='${cell.char}', expected empty`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCDE");
		ctx.write("\x1B[?2J");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response after DECSED"
		};
		return { pass: true };
	}),
	probe("erase.el-with-attrs", (ctx) => {
		ctx.feed("\x1B[42m");
		ctx.feed("XXXXX");
		ctx.feed("\x1B[1G");
		ctx.feed("\x1B[K");
		const cell = ctx.getCell(0, 0);
		const hasBg = cell.bg !== null && cell.bg.g > 100;
		ctx.feed("\x1B[0m");
		return {
			pass: hasBg,
			note: hasBg ? void 0 : `bg=${JSON.stringify(cell.bg)}, expected green`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[42m");
		ctx.write("XXXXX");
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[K");
		ctx.write("\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("erase.ed-scroll-region", (ctx) => {
		ctx.feed("KEEP_THIS\r\n");
		for (let i = 1; i <= 5; i++) ctx.feed(`row${i}\r\n`);
		ctx.feed("\x1B[3;10r");
		ctx.feed("\x1B[3;1H");
		ctx.feed("\x1B[J");
		const cell = ctx.getCell(0, 0);
		const pass = cell.char === "K";
		ctx.feed("\x1B[r");
		return {
			pass,
			note: pass ? void 0 : `row 0 char='${cell.char}', expected 'K'`
		};
	}, async (ctx) => {
		ctx.write("\x1B[2J\x1B[H");
		ctx.write("KEEP_THIS\r\n");
		for (let i = 1; i <= 5; i++) ctx.write(`row${i}\r\n`);
		ctx.write("\x1B[3;10r");
		ctx.write("\x1B[3;1H");
		ctx.write("\x1B[J");
		ctx.write("\x1B[r");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response"
		};
		return { pass: true };
	})
];
//#endregion
//#region src/editing.ts
const editingProbes = [
	probe("editing.insert-chars", (ctx) => {
		ctx.feed("ABCDE\x1B[1G\x1B[2@");
		return { pass: isBlank(ctx.getCell(0, 0).char) && isBlank(ctx.getCell(0, 1).char) && ctx.getCell(0, 2).char === "A" && ctx.getCell(0, 3).char === "B" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCD");
		ctx.write("\x1B[1;2H");
		ctx.write("\x1B[1@");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("editing.delete-chars", (ctx) => {
		ctx.feed("ABCDE\x1B[1G\x1B[2P");
		return { pass: ctx.getCell(0, 0).char === "C" && ctx.getCell(0, 1).char === "D" && ctx.getCell(0, 2).char === "E" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCD");
		ctx.write("\x1B[1;2H");
		ctx.write("\x1B[1P");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("editing.insert-lines", (ctx) => {
		ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1B[2;1H\x1B[1L");
		const r1 = ctx.getCell(1, 0).char;
		return { pass: isBlank(r1) && ctx.getCell(2, 0).char === "L" };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B[1L");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 3,
			note: pos.row === 3 ? void 0 : `cursor at row ${pos.row}, expected 3`
		};
	}),
	probe("editing.delete-lines", (ctx) => {
		ctx.feed("LINE1\r\nLINE2\r\nLINE3\x1B[2;1H\x1B[1M");
		return { pass: ctx.getCell(1, 0).char === "L" && ctx.getCell(1, 4).char === "3" };
	}, async (ctx) => {
		ctx.write("\x1B[3;5H");
		ctx.write("\x1B[1M");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 3,
			note: pos.row === 3 ? void 0 : `cursor at row ${pos.row}, expected 3`
		};
	}),
	probe("editing.repeat-char", (ctx) => {
		ctx.feed("X\x1B[4b");
		return { pass: ctx.getCell(0, 0).char === "X" && ctx.getCell(0, 1).char === "X" && ctx.getCell(0, 4).char === "X" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("X");
		ctx.write("\x1B[4b");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 6,
			note: pos.col === 6 ? void 0 : `cursor at col ${pos.col}, expected 6`
		};
	}),
	probe("editing.decfra", (ctx) => {
		ctx.feed("\x1B[88;1;1;3;5$x");
		for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) if (ctx.getCell(row, col).char !== "X") return {
			pass: false,
			note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected "X"`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[88;1;1;3;5$x");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decera", (ctx) => {
		ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1B[1;1H");
		ctx.feed("\x1B[1;1;3;5$z");
		for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) if (!isBlank(ctx.getCell(row, col).char)) return {
			pass: false,
			note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected blank`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[1;1;3;5$z");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decsera", (ctx) => {
		ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1B[1;1H");
		ctx.feed("\x1B[1;1;3;5${");
		for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) if (!isBlank(ctx.getCell(row, col).char)) return {
			pass: false,
			note: `cell(${row},${col})="${ctx.getCell(row, col).char}", expected blank`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[1;1;3;5${");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.deccra", (ctx) => {
		ctx.feed("HELLO\x1B[1;1H");
		ctx.feed("\x1B[1;1;1;5;1;3;1;1$v");
		const srcOk = ctx.getCell(0, 0).char === "H" && ctx.getCell(0, 1).char === "E" && ctx.getCell(0, 2).char === "L" && ctx.getCell(0, 3).char === "L" && ctx.getCell(0, 4).char === "O";
		const dstOk = ctx.getCell(2, 0).char === "H" && ctx.getCell(2, 1).char === "E" && ctx.getCell(2, 2).char === "L" && ctx.getCell(2, 3).char === "L" && ctx.getCell(2, 4).char === "O";
		if (!srcOk) return {
			pass: false,
			note: "source row corrupted after copy"
		};
		if (!dstOk) return {
			pass: false,
			note: `dest row="${[
				0,
				1,
				2,
				3,
				4
			].map((c) => ctx.getCell(2, c).char).join("")}", expected "HELLO"`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[1;1;2;5;1;5;10$v");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.deccara", (ctx) => {
		ctx.feed("AAAAA\r\nBBBBB\r\nCCCCC\x1B[1;1H");
		ctx.feed("\x1B[1;1;3;5;7$r");
		for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) if (!ctx.getCell(row, col).inverse) return {
			pass: false,
			note: `cell(${row},${col}).inverse=false, expected true`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[1;1;3;5;7$r");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decrara", (ctx) => {
		ctx.feed("\x1B[7mAAAAA\x1B[0m\r\n\x1B[7mBBBBB\x1B[0m\r\n\x1B[7mCCCCC\x1B[0m\x1B[1;1H");
		if (!ctx.getCell(0, 0).inverse) return {
			pass: false,
			note: "pre-condition: inverse not set on cell(0,0)"
		};
		ctx.feed("\x1B[1;1;3;5;7$t");
		for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) if (ctx.getCell(row, col).inverse) return {
			pass: false,
			note: `cell(${row},${col}).inverse=true after toggle, expected false`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[1;1;3;5;7$t");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decsace", (ctx) => {
		ctx.feed("\x1B[1;1H\x1B[2*x");
		const noLeak = !ctx.getText().includes("*x");
		return {
			pass: noLeak,
			note: noLeak ? "sequence consumed" : "literal leak detected"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1B[2*x");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decrqcra", (ctx) => {
		ctx.feed("ABCDE\x1B[1;1H");
		const response = ctx.feedCapture("\x1B[1;1;1;1;5*y");
		const match = /\x1bP(\d+)!~([0-9A-Fa-f]+)\x1b\\/.test(response);
		return {
			pass: match,
			note: match ? void 0 : `response: ${JSON.stringify(response)}`,
			response
		};
	}, async (ctx) => {
		const result = await ctx.query("\x1B[1;1;1;1;1;1*y", /\x1bP(\d+)!~([0-9A-Fa-f]+)\x1b\\/, 2e3);
		return {
			pass: result !== null,
			note: result ? "checksum response received" : "no DECRQCRA response",
			response: result ? result[0] : void 0
		};
	}),
	probe("editing.sl", (ctx) => {
		ctx.feed("\x1B[1;1H\x1B[2K1234567");
		ctx.feed("\x1B[2 @");
		const c0 = ctx.getCell(0, 0).char;
		const c1 = ctx.getCell(0, 1).char;
		const c2 = ctx.getCell(0, 2).char;
		const c3 = ctx.getCell(0, 3).char;
		const c4 = ctx.getCell(0, 4).char;
		if (!(c0 === "3" && c1 === "4" && c2 === "5" && c3 === "6" && c4 === "7")) return {
			pass: false,
			note: `got "${[
				c0,
				c1,
				c2,
				c3,
				c4
			].join("")}", expected "34567"`
		};
		if (!isBlank(ctx.getCell(0, 5).char) || !isBlank(ctx.getCell(0, 6).char)) return {
			pass: false,
			note: "right edge not blank after shift left"
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("1234567");
		ctx.write("\x1B[2 @");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.sr", (ctx) => {
		ctx.feed("\x1B[1;1H\x1B[2K1234567");
		ctx.feed("\x1B[2 A");
		const c0 = ctx.getCell(0, 0).char;
		const c1 = ctx.getCell(0, 1).char;
		const c2 = ctx.getCell(0, 2).char;
		const c3 = ctx.getCell(0, 3).char;
		const blanks = isBlank(c0) && isBlank(c1);
		const shifted = c2 === "1" && c3 === "2";
		if (!blanks) return {
			pass: false,
			note: `cols 0-1 not blank: "${c0}${c1}"`
		};
		if (!shifted) return {
			pass: false,
			note: `cols 2-3 expected "12", got "${c2}${c3}"`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("1234567");
		ctx.write("\x1B[2 A");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decic", (ctx) => {
		ctx.feed("ABCDE\r\nABCDE\x1B[1;3H");
		ctx.feed("\x1B[2'}");
		const r0c0 = ctx.getCell(0, 0).char;
		const r0c1 = ctx.getCell(0, 1).char;
		const r0c2 = ctx.getCell(0, 2).char;
		const r0c3 = ctx.getCell(0, 3).char;
		const r0c4 = ctx.getCell(0, 4).char;
		if (r0c0 !== "A" || r0c1 !== "B") return {
			pass: false,
			note: `cols 0-1 expected "AB", got "${r0c0}${r0c1}"`
		};
		if (!isBlank(r0c2) || !isBlank(r0c3)) return {
			pass: false,
			note: `inserted cols 2-3 not blank: "${r0c2}${r0c3}"`
		};
		if (r0c4 !== "C") return {
			pass: false,
			note: `col 4 expected "C", got "${r0c4}"`
		};
		const r1c2 = ctx.getCell(1, 2).char;
		const r1c4 = ctx.getCell(1, 4).char;
		if (!isBlank(r1c2)) return {
			pass: false,
			note: `row 1 col 2 not blank: "${r1c2}"`
		};
		if (r1c4 !== "C") return {
			pass: false,
			note: `row 1 col 4 expected "C", got "${r1c4}"`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[3;3H");
		ctx.write("\x1B[2'}");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	}),
	probe("editing.decdc", (ctx) => {
		ctx.feed("ABCDE\r\nABCDE\x1B[1;2H");
		ctx.feed("\x1B[2'~");
		const r0c0 = ctx.getCell(0, 0).char;
		const r0c1 = ctx.getCell(0, 1).char;
		const r0c2 = ctx.getCell(0, 2).char;
		if (r0c0 !== "A") return {
			pass: false,
			note: `col 0 expected "A", got "${r0c0}"`
		};
		if (r0c1 !== "D") return {
			pass: false,
			note: `col 1 expected "D", got "${r0c1}"`
		};
		if (r0c2 !== "E") return {
			pass: false,
			note: `col 2 expected "E", got "${r0c2}"`
		};
		if (!isBlank(ctx.getCell(0, 3).char) || !isBlank(ctx.getCell(0, 4).char)) return {
			pass: false,
			note: "right edge not blank after column delete"
		};
		const r1c1 = ctx.getCell(1, 1).char;
		if (r1c1 !== "D") return {
			pass: false,
			note: `row 1 col 1 expected "D", got "${r1c1}"`
		};
		return { pass: true };
	}, async (ctx) => {
		ctx.write("\x1B[3;3H");
		ctx.write("\x1B[2'~");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? "sequence consumed" : "no cursor response"
		};
	})
];
//#endregion
//#region src/modes.ts
async function responsiveAfterEnable(ctx) {
	const pos = await ctx.queryCursorPosition();
	return {
		pass: pos !== null,
		note: pos ? "Behavioral: responsive after enable" : "No response"
	};
}
const modesProbes = [
	behavioralModeProbe("modes.alt-screen.enter", "\x1B[?1049h", "\x1B[?1049l", 1049, (ctx) => {
		ctx.feed("\x1B[?1049h");
		return { pass: ctx.getMode("altScreen") === true };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("TEST");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response in alt screen"
		};
		return {
			pass: true,
			note: "Behavioral: entered and responded"
		};
	}),
	probe("modes.alt-screen.exit", (ctx) => {
		ctx.feed("\x1B[?1049h\x1B[?1049l");
		return { pass: ctx.getMode("altScreen") === false };
	}, async (ctx) => {
		ctx.write("\x1B[?1049h");
		ctx.write("\x1B[3;3H");
		ctx.write("\x1B[?1049l");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response after exit"
		};
		return { pass: true };
	}),
	behavioralModeProbe("modes.bracketed-paste", "\x1B[?2004h", "\x1B[?2004l", 2004, (ctx) => {
		ctx.feed("\x1B[?2004h");
		return { pass: ctx.getMode("bracketedPaste") === true };
	}, async (ctx) => {
		if (!await ctx.query("\x1B[c", /\x1b\[\?([0-9;]+)c/, 1e3)) return {
			pass: false,
			note: "No DA1 response after enabling bracketed paste"
		};
		return {
			pass: true,
			note: "Behavioral: terminal responsive after enable"
		};
	}),
	behavioralModeProbe("modes.application-cursor", "\x1B[?1h", "\x1B[?1l", 1, (ctx) => {
		ctx.feed("\x1B[?1h");
		return { pass: ctx.getMode("applicationCursor") === true };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.auto-wrap", "\x1B[?7h", "", 7, (ctx) => {
		ctx.feed("X".repeat(80) + "Y");
		return { pass: ctx.getCell(1, 0).char === "Y" };
	}, async (ctx) => {
		const cols = ctx.cols;
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("A".repeat(cols) + "B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 2,
			note: pos.row === 2 ? "Behavioral: wrap confirmed" : `cursor at row ${pos.row}, expected 2`
		};
	}),
	behavioralModeProbe("modes.mouse-tracking", "\x1B[?1000h", "\x1B[?1000l", 1e3, (ctx) => {
		ctx.feed("\x1B[?1000h");
		return { pass: ctx.getMode("mouseTracking") === true };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.focus-tracking", "\x1B[?1004h", "\x1B[?1004l", 1004, (ctx) => {
		ctx.feed("\x1B[?1004h");
		return { pass: ctx.getMode("focusTracking") === true };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.reverse-video", "\x1B[?5h", "\x1B[?5l", 5, (ctx) => {
		ctx.feed("\x1B[?5h");
		return { pass: ctx.getMode("reverseVideo") === true };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.synchronized-output", "\x1B[?2026h", "\x1B[?2026l", 2026, (ctx) => {
		ctx.feed("\x1B[?2026h");
		ctx.feed("Hello");
		ctx.feed("\x1B[?2026l");
		return { pass: ctx.getText().includes("Hello") };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.origin", "\x1B[?6h", "\x1B[?6l", 6, (ctx) => {
		ctx.feed("\x1B[?6h");
		const result = ctx.getMode("originMode") === true;
		ctx.feed("\x1B[?6l");
		return { pass: result };
	}, async (ctx) => {
		ctx.write("\x1B[5;10r");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[r");
		if (!pos) return {
			pass: false,
			note: "No response"
		};
		return {
			pass: pos.row >= 5,
			note: `Behavioral: cursor at row ${pos.row} (origin mapped)`
		};
	}),
	probe("modes.insert-replace", (ctx) => {
		ctx.feed("ABC\x1B[1G\x1B[4hX");
		const result = ctx.getMode("insertMode") === true;
		const cell0 = ctx.getCell(0, 0).char === "X";
		const cell1 = ctx.getCell(0, 1).char === "A";
		ctx.feed("\x1B[4l");
		return { pass: result && cell0 && cell1 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("ABCD");
		ctx.write("\x1B[1;2H");
		ctx.write("\x1B[4h");
		ctx.write("X");
		ctx.write("\x1B[4l");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 3,
			note: pos.col === 3 ? void 0 : `cursor at col ${pos.col}, expected 3`
		};
	}),
	behavioralModeProbe("modes.mouse-sgr", "\x1B[?1006h", "\x1B[?1006l", 1006, (ctx) => {
		ctx.feed("\x1B[?1006h");
		const pass = ctx.getMode("sgrMouse") === true;
		ctx.feed("\x1B[?1006l");
		return { pass };
	}, responsiveAfterEnable),
	behavioralModeProbe("modes.mouse-all", "\x1B[?1003h", "\x1B[?1003l", 1003, (ctx) => {
		ctx.feed("\x1B[?1003h");
		const pass = ctx.getMode("mouseTracking") === true;
		ctx.feed("\x1B[?1003l");
		return { pass };
	}, responsiveAfterEnable),
	probe("modes.application-keypad", (ctx) => {
		ctx.feed("\x1B=");
		const on = ctx.getMode("applicationKeypad") === true;
		ctx.feed("\x1B>");
		const off = ctx.getMode("applicationKeypad") === false;
		return { pass: on && off };
	}, async (ctx) => {
		ctx.write("\x1B=");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B>");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after DECKPAM"
		};
	}),
	probe("modes.left-right-margin", (ctx) => {
		ctx.feed("\x1B[?69h");
		const pass = ctx.getMode("leftRightMargin") === true;
		ctx.feed("\x1B[?69l");
		return { pass };
	}, async (ctx) => {
		ctx.write("\x1B[?69h");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?69l");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after DECLRMM"
		};
	}),
	probe("modes.altscreen-47", (ctx) => {
		ctx.feed("\x1B[?47h");
		const entered = ctx.getMode("altScreen") === true;
		ctx.feed("\x1B[?47l");
		const exited = ctx.getMode("altScreen") === false;
		return {
			pass: entered && exited,
			note: !entered ? "altScreen not set" : !exited ? "altScreen not cleared" : void 0
		};
	}, async (ctx) => {
		ctx.write("\x1B[?47h");
		const inAlt = await ctx.queryCursorPosition();
		ctx.write("\x1B[?47l");
		const out = await ctx.queryCursorPosition();
		if (!inAlt || !out) return {
			pass: false,
			note: "No cursor response around ?47"
		};
		return {
			pass: true,
			note: "Behavioral: ?47 enter/exit accepted"
		};
	}),
	probe("modes.altscreen-1047", (ctx) => {
		ctx.feed("\x1B[?1047h");
		const entered = ctx.getMode("altScreen") === true;
		ctx.feed("\x1B[?1047l");
		const exited = ctx.getMode("altScreen") === false;
		return {
			pass: entered && exited,
			note: !entered ? "altScreen not set" : !exited ? "altScreen not cleared" : void 0
		};
	}, async (ctx) => {
		const decrpmResult = await ctx.queryMode(1047);
		if (decrpmResult !== null && decrpmResult !== "unknown") return {
			pass: true,
			note: `DECRPM: mode ${decrpmResult}`,
			response: decrpmResult
		};
		ctx.write("\x1B[?1047h");
		const inAlt = await ctx.queryCursorPosition();
		ctx.write("\x1B[?1047l");
		if (!inAlt) return {
			pass: false,
			note: "No cursor response after enable"
		};
		return {
			pass: true,
			note: "Behavioral: ?1047 accepted"
		};
	}),
	probe("modes.altscreen-1048", (ctx) => {
		ctx.feed("\x1B[5;10H");
		ctx.feed("\x1B[?1048h");
		ctx.feed("\x1B[15;20H");
		ctx.feed("\x1B[?1048l");
		const cursor = ctx.getCursor();
		const pass = cursor.y === 4 && cursor.x === 9;
		return {
			pass,
			note: pass ? void 0 : `cursor at ${cursor.y};${cursor.x}, expected 4;9 after restore`
		};
	}, async (ctx) => {
		ctx.write("\x1B[5;10H");
		ctx.write("\x1B[?1048h");
		ctx.write("\x1B[15;20H");
		ctx.write("\x1B[?1048l");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after restore"
		};
		return {
			pass: pos.row === 5 && pos.col === 10,
			note: pos.row === 5 && pos.col === 10 ? void 0 : `got ${pos.row};${pos.col}, expected 5;10`,
			response: `${pos.row};${pos.col}`
		};
	}),
	probe("modes.alt-scroll-1007", (ctx) => {
		ctx.feed("\x1B[?1007h");
		const response = ctx.feedCapture("\x1B[?1007$p");
		ctx.feed("\x1B[?1007l");
		if (response.includes("$y")) {
			const set = response.includes("1007;1$y");
			return {
				pass: set,
				note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
				response
			};
		}
		ctx.feed("X");
		const ok = ctx.getCell(0, 0).char === "X";
		return {
			pass: ok,
			note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke"
		};
	}, async (ctx) => {
		const decrpmResult = await ctx.queryMode(1007);
		if (decrpmResult !== null && decrpmResult !== "unknown") return {
			pass: true,
			note: `DECRPM: mode ${decrpmResult}`,
			response: decrpmResult
		};
		ctx.write("\x1B[?1007h");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?1007l");
		return {
			pass: pos !== null,
			note: pos ? "Behavioral: ?1007 accepted" : "No cursor response after enable"
		};
	}),
	probe("modes.utf8-mouse-1005", (ctx) => {
		ctx.feed("\x1B[?1005h");
		const response = ctx.feedCapture("\x1B[?1005$p");
		ctx.feed("\x1B[?1005l");
		if (response.includes("$y")) {
			const set = response.includes("1005;1$y");
			return {
				pass: set,
				note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
				response
			};
		}
		ctx.feed("X");
		const ok = ctx.getCell(0, 0).char === "X";
		return {
			pass: ok,
			note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke"
		};
	}, async (ctx) => {
		const decrpmResult = await ctx.queryMode(1005);
		if (decrpmResult !== null && decrpmResult !== "unknown") return {
			pass: true,
			note: `DECRPM: mode ${decrpmResult}`,
			response: decrpmResult
		};
		ctx.write("\x1B[?1005h");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?1005l");
		return {
			pass: pos !== null,
			note: pos ? "Behavioral: ?1005 accepted" : "No cursor response after enable"
		};
	}),
	probe("modes.deccolm", (ctx) => {
		ctx.feed("\x1B[?3h");
		const response = ctx.feedCapture("\x1B[?3$p");
		ctx.feed("\x1B[?3l");
		if (response.includes("$y")) {
			const set = response.includes("3;1$y");
			return {
				pass: set,
				note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
				response
			};
		}
		ctx.feed("X");
		const ok = ctx.getText().includes("X");
		return {
			pass: ok,
			note: ok ? "Sequence parsed (DECRPM not supported)" : "Parser broke"
		};
	}, async (ctx) => {
		const decrpmResult = await ctx.queryMode(3);
		if (decrpmResult !== null && decrpmResult !== "unknown") return {
			pass: true,
			note: `DECRPM: mode ${decrpmResult}`,
			response: decrpmResult
		};
		ctx.write("\x1B[?3h");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?3l");
		return {
			pass: pos !== null,
			note: pos ? "Behavioral: ?3 accepted" : "No cursor response after enable"
		};
	}),
	probe("modes.decsclm", (ctx) => {
		ctx.feed("\x1B[?4h");
		const response = ctx.feedCapture("\x1B[?4$p");
		ctx.feed("\x1B[?4l");
		const set = response.includes("?4;1$y");
		return {
			pass: set,
			note: set ? "DECRPM: mode set" : `DECRPM: mode not set (${JSON.stringify(response)})`,
			response
		};
	}, async (ctx) => {
		ctx.write("\x1B[?4h");
		const result = await ctx.queryMode(4);
		ctx.write("\x1B[?4l");
		return {
			pass: result === "set",
			note: result === "set" ? "DECRPM: mode set" : `DECRPM: mode ${result ?? "no response"}`,
			response: result ?? void 0
		};
	}),
	probe("modes.color-scheme-reporting", (ctx) => {
		ctx.feed("\x1B[?2031h");
		const enabled = ctx.getMode("colorSchemeReporting");
		ctx.feed("\x1B[?2031l");
		return { pass: enabled === true };
	}, async (ctx) => {
		const result = await ctx.queryMode(2031);
		if (result !== null && result !== "unknown") return {
			pass: true,
			note: `DECRPM: mode ${result}`,
			response: result
		};
		const match = await ctx.queryWithSentinel("\x1B[?997n", /\x1b\[\?997;(\d+)n/);
		if (match) return {
			pass: true,
			note: match[1] === "1" ? "dark" : match[1] === "2" ? "light" : `unknown(${match[1]})`,
			response: match[1]
		};
		return {
			pass: false,
			note: "No DECRPM or DECDSR 997 response"
		};
	}),
	probe("modes.xtpushsgr", (ctx) => {
		const pushOut = ctx.feedCapture("\x1B[#{");
		if (pushOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(pushOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		ctx.feed("\x1B[#}");
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after push"
		};
	}, async (ctx) => {
		ctx.write("\x1B[#{");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[#}");
		if (!pos) return {
			pass: false,
			note: "No DSR response after XTPUSHSGR"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("modes.xtpopsgr", (ctx) => {
		ctx.feed("\x1B[#{");
		const popOut = ctx.feedCapture("\x1B[#}");
		if (popOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(popOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after pop"
		};
	}, async (ctx) => {
		ctx.write("\x1B[#{");
		ctx.write("\x1B[#}");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No DSR response after XTPOPSGR"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("modes.xtsave", (ctx) => {
		const saveOut = ctx.feedCapture("\x1B[?7s");
		if (saveOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(saveOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		ctx.feed("\x1B[?7r");
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after XTSAVE"
		};
	}, async (ctx) => {
		ctx.write("\x1B[?7s");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[?7r");
		if (!pos) return {
			pass: false,
			note: "No DSR response after XTSAVE"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("modes.xtrestore", (ctx) => {
		ctx.feed("\x1B[?7s");
		const restoreOut = ctx.feedCapture("\x1B[?7r");
		if (restoreOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(restoreOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after XTRESTORE"
		};
	}, async (ctx) => {
		ctx.write("\x1B[?7s");
		ctx.write("\x1B[?7r");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No DSR response after XTRESTORE"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("modes.xtpushcolors", (ctx) => {
		const pushOut = ctx.feedCapture("\x1B[#P");
		if (pushOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(pushOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		ctx.feed("\x1B[#Q");
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after push"
		};
	}, async (ctx) => {
		ctx.write("\x1B[#P");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[#Q");
		if (!pos) return {
			pass: false,
			note: "No DSR response after XTPUSHCOLORS"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("modes.xtpopcolors", (ctx) => {
		ctx.feed("\x1B[#P");
		const popOut = ctx.feedCapture("\x1B[#Q");
		if (popOut.length > 0) return {
			pass: false,
			note: `Unexpected output: ${JSON.stringify(popOut)}`
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		const ok = /\x1b\[\?[0-9;]+c/.test(probeResponse);
		return {
			pass: ok,
			note: ok ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after pop"
		};
	}, async (ctx) => {
		ctx.write("\x1B[#P");
		ctx.write("\x1B[#Q");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No DSR response after XTPOPCOLORS"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	})
];
//#endregion
//#region src/device.ts
const deviceProbes = [
	responseProbe("device.primary-da", "\x1B[c", /\x1b\[\?([0-9;]+)c/, (response) => ({
		pass: response.includes("?") && response.endsWith("c"),
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[c", /\x1b\[\?([0-9;]+)c/, 1e3);
		if (!match) return {
			pass: false,
			note: "No DA1 response"
		};
		return {
			pass: true,
			response: match[0]
		};
	}),
	responseProbe("device.status-report", "\x1B[5n", /\x1b\[(\d+)n/, (response) => ({
		pass: response.includes("0n"),
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[5n", /\x1b\[(\d+)n/, 1e3);
		if (!match) return {
			pass: false,
			note: "No DSR 5 response"
		};
		return {
			pass: match[1] === "0",
			note: match[1] === "0" ? void 0 : `status ${match[1]}`,
			response: match[0]
		};
	}),
	responseProbe("device.secondary-da", "\x1B[>c", /\x1b\[>([0-9;]+)c/, (response) => ({
		pass: response.includes(">"),
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[>c", /\x1b\[>([0-9;]+)c/, 1e3);
		if (!match) return {
			pass: false,
			note: "No DA2 response"
		};
		return {
			pass: true,
			response: match[0]
		};
	}),
	responseProbe("device.tertiary-da", "\x1B[=c", /./, (response) => ({
		pass: response.length > 0,
		response
	}), async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[=c", /\x1bP!?\|([^\x1b]*)\x1b\\/);
		if (match) return {
			pass: true,
			response: match[1]
		};
		return {
			pass: false,
			note: "No DA3 response"
		};
	}),
	responseProbe("device.decrqss", "\x1BP$q\"p\x1B\\", /./, (response) => ({
		pass: response.length > 0,
		response
	}), async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1BP$q\"p\x1B\\", /\x1bP([01])\$r/);
		if (match) return {
			pass: true,
			response: match[0]
		};
		return {
			pass: false,
			note: "No DECRQSS response"
		};
	}),
	responseProbe("device.xtgettcap", "\x1BP+q544e\x1B\\", /./, (response) => ({
		pass: response.length > 0,
		response
	}), async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1BP+q544e\x1B\\", /\x1bP([01])\+r/);
		if (match) return {
			pass: true,
			response: match[0]
		};
		return {
			pass: false,
			note: "No XTGETTCAP response"
		};
	}),
	probe("device.decrpm", (ctx) => {
		const response = ctx.feedCapture("\x1B[?1$p");
		return {
			pass: response.includes("$y"),
			response
		};
	}, async (ctx) => {
		const result = await ctx.queryMode(7);
		if (result === null) return {
			pass: false,
			note: "No DECRPM response"
		};
		return {
			pass: result !== "unknown",
			note: result === "unknown" ? "Terminal does not support DECRPM" : `DECAWM is ${result}`,
			response: result
		};
	}),
	responseProbe("device.xtversion", "\x1B[>0q", /\x1bP>\|/, (response) => ({
		pass: response.length > 0 && response.includes(">|"),
		response
	}), async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[>0q", /\x1bP>\|([^\x1b]+)\x1b\\/);
		if (!match) return {
			pass: false,
			note: "No XTVERSION response"
		};
		return {
			pass: true,
			response: match[1]
		};
	}),
	probe("device.term-features", null, async (_ctx) => {
		const value = typeof process !== "undefined" ? process.env.TERM_FEATURES : void 0;
		if (!value) return {
			pass: false,
			note: "TERM_FEATURES env var not set"
		};
		return {
			pass: true,
			response: value
		};
	}),
	probe("device.dsr-996-color-scheme", (ctx) => {
		const response = ctx.feedCapture("\x1B[?996n");
		const match = /\x1b\[\?997;([12])n/.exec(response);
		if (!match) return {
			pass: false,
			note: "No DSR ?997 color-scheme response",
			response
		};
		return {
			pass: true,
			note: match[1] === "1" ? "dark" : "light",
			response
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[?996n", /\x1b\[\?997;([12])n/);
		if (!match) return {
			pass: false,
			note: "No DSR ?997 color-scheme response"
		};
		return {
			pass: true,
			note: match[1] === "1" ? "dark" : "light",
			response: match[0]
		};
	}),
	responseProbe("device.xtwinops-14", "\x1B[14t", /\x1b\[4;(\d+);(\d+)t/, (response) => ({
		pass: /\x1b\[4;\d+;\d+t/.test(response),
		note: /\x1b\[4;\d+;\d+t/.test(response) ? void 0 : `Response: ${JSON.stringify(response)}`,
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[14t", /\x1b\[4;(\d+);(\d+)t/, 1e3);
		if (!match) return {
			pass: false,
			note: "No XTWINOPS 14 response"
		};
		return {
			pass: true,
			response: match[0],
			note: `${match[1]}x${match[2]} px`
		};
	}),
	responseProbe("device.xtwinops-16", "\x1B[16t", /\x1b\[6;(\d+);(\d+)t/, (response) => ({
		pass: /\x1b\[6;\d+;\d+t/.test(response),
		note: /\x1b\[6;\d+;\d+t/.test(response) ? void 0 : `Response: ${JSON.stringify(response)}`,
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[16t", /\x1b\[6;(\d+);(\d+)t/, 1e3);
		if (!match) return {
			pass: false,
			note: "No XTWINOPS 16 response"
		};
		return {
			pass: true,
			response: match[0],
			note: `${match[1]}x${match[2]} px/cell`
		};
	}),
	responseProbe("device.xtwinops-18", "\x1B[18t", /\x1b\[8;(\d+);(\d+)t/, (response) => ({
		pass: /\x1b\[8;\d+;\d+t/.test(response),
		note: /\x1b\[8;\d+;\d+t/.test(response) ? void 0 : `Response: ${JSON.stringify(response)}`,
		response
	}), async (ctx) => {
		const match = await ctx.query("\x1B[18t", /\x1b\[8;(\d+);(\d+)t/, 1e3);
		if (!match) return {
			pass: false,
			note: "No XTWINOPS 18 response"
		};
		return {
			pass: true,
			response: match[0],
			note: `${match[1]} rows x ${match[2]} cols`
		};
	}),
	probe("device.xtwinops-20", (ctx) => {
		ctx.feed("\x1B]1;test-icon\x07");
		const response = ctx.feedCapture("\x1B[20t");
		const oscLMatch = /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(response);
		if (oscLMatch) return {
			pass: true,
			response,
			note: `icon label: ${oscLMatch[1]}`
		};
		if (response.length > 0) return {
			pass: true,
			response,
			note: "Response received (non-standard format)"
		};
		return {
			pass: false,
			note: "No response to icon label query"
		};
	}, async (ctx) => {
		ctx.write("\x1B]1;test-icon\x07");
		const match = await ctx.queryWithSentinel("\x1B[20t", /\x1b\]L([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1e3);
		if (match) return {
			pass: true,
			response: match[0],
			note: `icon label: ${match[1]}`
		};
		return {
			pass: false,
			note: "No XTWINOPS 20 response (terminal may refuse for security)"
		};
	}),
	probe("device.xtwinops-21", (ctx) => {
		ctx.feed("\x1B]2;test-title\x07");
		const response = ctx.feedCapture("\x1B[21t");
		const oscMatch = /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(response);
		if (oscMatch) return {
			pass: true,
			response,
			note: `title: ${oscMatch[1]}`
		};
		if (response.length > 0) return {
			pass: true,
			response,
			note: "Response received (non-standard format)"
		};
		return {
			pass: false,
			note: "No response to title query"
		};
	}, async (ctx) => {
		ctx.write("\x1B]2;test-title\x07");
		const match = await ctx.queryWithSentinel("\x1B[21t", /\x1b\]l([^\x07\x1b]*)(?:\x07|\x1b\\)/, 1e3);
		if (match) return {
			pass: true,
			response: match[0],
			note: `title: ${match[1]}`
		};
		return {
			pass: false,
			note: "No XTWINOPS 21 response (terminal may refuse for security)"
		};
	}),
	probe("device.xtwinops-22", (ctx) => {
		ctx.feed("\x1B]2;pushed-title\x07");
		ctx.feed("\x1B[22;0t");
		ctx.feed("\x1B]2;new-title\x07");
		const title = ctx.getTitle();
		if (title === "new-title") return {
			pass: true,
			note: "Push succeeded; title changed after push"
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		return {
			pass: /\x1b\[\?[0-9;]+c/.test(probeResponse),
			note: /\x1b\[\?[0-9;]+c/.test(probeResponse) ? `Push consumed; title is "${title}"` : "Terminal unresponsive after push"
		};
	}, async (ctx) => {
		ctx.write("\x1B]2;pushed-title\x07");
		ctx.write("\x1B[22;0t");
		ctx.write("\x1B]2;new-title\x07");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No DSR response after push"
		};
		return {
			pass: true,
			note: "Push sequence accepted; terminal responsive"
		};
	}),
	probe("device.xtwinops-23", (ctx) => {
		ctx.feedCapture("\x1B[22;0t");
		ctx.feedCapture("\x1B[23;0t");
		const probeResponse = ctx.feedCapture("\x1B[c");
		return {
			pass: /\x1b\[\?[0-9;]+c/.test(probeResponse),
			note: /\x1b\[\?[0-9;]+c/.test(probeResponse) ? "Sequence consumed; terminal responsive" : "Terminal unresponsive after pop"
		};
	}, async (ctx) => {
		ctx.write("\x1B[22;0t");
		ctx.write("\x1B[23;0t");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No DSR response after pop"
		};
		return {
			pass: true,
			note: "Sequence consumed; terminal responsive"
		};
	}),
	probe("device.xtreportcolors", (ctx) => {
		const response = ctx.feedCapture("\x1B[#R");
		if (/\x1b\[[0-9;]*#Q/.test(response)) return {
			pass: true,
			response,
			note: "XTREPORTCOLORS response received"
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		return {
			pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("#R"),
			note: /\x1b\[\?[0-9;]+c/.test(probeResponse) ? "Sequence consumed; terminal responsive (no XTREPORTCOLORS response)" : "Terminal unresponsive after CSI # R"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[#R", /\x1b\[([0-9;]*)#Q/, 1e3);
		if (match) return {
			pass: true,
			response: match[0],
			note: `Pm=${match[1]}`
		};
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No response after CSI # R"
		};
		return {
			pass: false,
			note: "Sequence consumed but no XTREPORTCOLORS response"
		};
	}),
	probe("device.xtgetxres", (ctx) => {
		const response = ctx.feedCapture("\x1BP+Q7874657271\x1B\\");
		if (/\x1bP[01]\+R/.test(response)) return {
			pass: true,
			response,
			note: "XTGETXRES response received"
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		return {
			pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("+Q"),
			note: /\x1b\[\?[0-9;]+c/.test(probeResponse) ? "Sequence consumed; terminal responsive (no XTGETXRES response)" : "Terminal unresponsive after DCS + Q"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1BP+Q7874657271\x1B\\", /\x1bP([01])\+R/);
		if (match) return {
			pass: true,
			response: match[0],
			note: `XTGETXRES status=${match[1]}`
		};
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No response after XTGETXRES"
		};
		return {
			pass: false,
			note: "Sequence consumed but no XTGETXRES response"
		};
	})
];
//#endregion
//#region src/extensions.ts
/** OSC color query probe — feedCapture + regex (termless), sentinel query (term). */
function oscColorQueryProbe(id, oscCode) {
	const querySeq = `\x1b]${oscCode};?\x07`;
	const termlessPattern = new RegExp(`\\x1b\\]${oscCode};`);
	const termPattern = new RegExp(`\\x1b\\]${oscCode};([^\\x07\\x1b]+)[\\x07\\x1b]`);
	return probe(id, (ctx) => {
		const response = ctx.feedCapture(querySeq);
		const pass = termlessPattern.test(response);
		return {
			pass,
			note: pass ? void 0 : `No OSC ${oscCode} response`
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel(querySeq, termPattern);
		if (!match) return {
			pass: false,
			note: `No OSC ${oscCode} response`
		};
		return {
			pass: true,
			response: match[1]
		};
	});
}
function oscQueryProbe(querySeq, responsePattern, noResponseNote) {
	return (ctx) => {
		const response = ctx.feedCapture(querySeq);
		const pass = responsePattern.test(response);
		return {
			pass,
			note: pass ? void 0 : noResponseNote,
			response
		};
	};
}
function pointerColorResetProbe(setCode, resetCode, defaultPattern) {
	return (ctx) => {
		ctx.feed(`\x1b]${setCode};rgb:12/34/56\x07`);
		ctx.feed(`\x1b]${resetCode}\x07`);
		const response = ctx.feedCapture(`\x1b]${setCode};?\x07`);
		const pass = defaultPattern.test(response);
		return {
			pass,
			note: pass ? void 0 : `OSC ${setCode} query did not report reset default`,
			response
		};
	};
}
function colorStackProbe() {
	return (ctx) => {
		const response = ctx.feedCapture("\x1B]10;rgb:10/20/30\x07\x1B]30001\x07\x1B]10;rgb:aa/bb/cc\x07\x1B]30101\x07\x1B]10;?\x07");
		const pass = /\x1b\]10;rgb:1010\/2020\/3030/.test(response);
		return {
			pass,
			note: pass ? void 0 : "Color stack did not restore OSC 10 foreground",
			response
		};
	};
}
function osc720ScrollProbe() {
	return (ctx) => {
		for (let i = 0; i < 30; i++) ctx.feed(`scroll-${i}\r\n`);
		const before = ctx.getScrollback();
		if (before.totalLines <= before.screenLines || before.viewportOffset <= 0) return {
			pass: false,
			note: `No scrollback to scroll (viewport=${before.viewportOffset}, total=${before.totalLines}, screen=${before.screenLines})`
		};
		ctx.feed("\x1B]720\x07");
		const after = ctx.getScrollback();
		const pass = after.viewportOffset < before.viewportOffset;
		return {
			pass,
			note: pass ? `viewport ${before.viewportOffset}→${after.viewportOffset}` : `viewport did not move up (${before.viewportOffset}→${after.viewportOffset})`
		};
	};
}
/** Kitty keyboard flag probe — push flags, query, check specific bit. */
function kittyKeyboardFlagProbe(id, pushValue, flagBit) {
	return probe(id, (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }), async (ctx) => {
		const match = await ctx.queryWithSentinel(`\x1b[>${pushValue}u\x1b[?u`, /\x1b\[\?(\d+)u/);
		ctx.write("\x1B[<u");
		if (!match) return {
			pass: false,
			note: "No kitty keyboard response"
		};
		const flags = parseInt(match[1], 10);
		return {
			pass: (flags & flagBit) !== 0,
			response: `flags=${flags}`
		};
	});
}
const extensionsProbes = [
	probe("extensions.truecolor", (ctx) => ({ pass: ctx.capabilities.truecolor === true }), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[38;2;255;0;128mX\x1B[0m");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (truecolor sequence may have been printed literally)`
		};
	}),
	probe("extensions.kitty-keyboard", (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }), async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[>1u\x1B[?u", /\x1b\[\?(\d+)u/);
		ctx.write("\x1B[<u");
		if (!match) return {
			pass: false,
			note: "No kitty keyboard response"
		};
		return {
			pass: true,
			response: `flags=${match[1]}`
		};
	}),
	kittyKeyboardFlagProbe("extensions.kitty-keyboard.disambiguate", 1, 1),
	kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-events", 3, 2),
	kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-alternate", 5, 4),
	kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-all-keys", 9, 8),
	kittyKeyboardFlagProbe("extensions.kitty-keyboard.report-text", 17, 16),
	probe("extensions.kitty-graphics", (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }), async (ctx) => {
		const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		ctx.write("\x1B[1;1H");
		ctx.write(`\x1b_Ga=T,f=100,s=1,v=1,t=d;${payload}\x1b\\`);
		await new Promise((r) => setTimeout(r, 300));
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after kitty graphics"
		};
		return {
			pass: pos.row > 1 || pos.col > 1,
			note: pos.row > 1 || pos.col > 1 ? void 0 : "Image didn't render"
		};
	}),
	probe("extensions.kitty-graphics.transmit", (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }), async (ctx) => {
		ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=999;iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\x1b\\`);
		await new Promise((r) => setTimeout(r, 300));
		const pos = await ctx.queryCursorPosition();
		ctx.write(`\x1b_Ga=d,d=i,i=999\x1b\\`);
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No response after transmit"
		};
	}),
	probe("extensions.kitty-graphics.display", (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }), async (ctx) => {
		ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=998,q=1;iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\x1b\\`);
		await new Promise((r) => setTimeout(r, 200));
		ctx.write("\x1B[1;1H");
		ctx.write(`\x1b_Ga=p,i=998\x1b\\`);
		await new Promise((r) => setTimeout(r, 300));
		const pos = await ctx.queryCursorPosition();
		ctx.write(`\x1b_Ga=d,d=i,i=998\x1b\\`);
		if (!pos) return {
			pass: false,
			note: "No response after display"
		};
		return {
			pass: pos.row > 1 || pos.col > 1,
			note: pos.row > 1 || pos.col > 1 ? void 0 : "Display didn't render"
		};
	}),
	probe("extensions.kitty-graphics.animation", (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }), async (ctx) => {
		const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		ctx.write(`\x1b_Ga=t,f=100,s=1,v=1,t=d,i=997,q=1;${payload}\x1b\\`);
		await new Promise((r) => setTimeout(r, 200));
		ctx.write(`\x1b_Ga=f,i=997,q=1;${payload}\x1b\\`);
		await new Promise((r) => setTimeout(r, 200));
		const pos = await ctx.queryCursorPosition();
		ctx.write(`\x1b_Ga=d,d=i,i=997\x1b\\`);
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No response after animation frame"
		};
	}),
	probe("extensions.kitty-graphics.unicode-placeholders", (ctx) => ({ pass: ctx.capabilities.kittyGraphics === true }), async (ctx) => {
		const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		ctx.write("\x1B[1;1H");
		ctx.write(`\x1b_Ga=T,f=100,s=1,v=1,t=d,U=1,i=996;${payload}\x1b\\`);
		await new Promise((r) => setTimeout(r, 300));
		const pos = await ctx.queryCursorPosition();
		ctx.write(`\x1b_Ga=d,d=i,i=996\x1b\\`);
		if (!pos) return {
			pass: false,
			note: "No response after U=1"
		};
		return {
			pass: pos.row > 1 || pos.col > 1,
			note: pos.row > 1 || pos.col > 1 ? void 0 : "U=1 didn't render"
		};
	}),
	probe("extensions.sixel", (ctx) => ({ pass: ctx.capabilities.sixel === true }), async (ctx) => {
		ctx.write("\x1B[1;1H");
		ctx.write("\x1BPq#0;2;0;0;0~-~\x1B\\");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after sixel"
		};
		const moved = pos.row > 1 || pos.col > 1;
		return {
			pass: moved,
			note: moved ? void 0 : "Sixel image didn't move cursor"
		};
	}),
	probe("extensions.osc8", (ctx) => ({ pass: ctx.capabilities.osc8Hyperlinks === true }), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]8;;http://example.com\x07link\x1B]8;;\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 5,
			note: pos.col === 5 ? void 0 : `cursor at col ${pos.col}, expected 5 (4 visible chars)`
		};
	}),
	probe("extensions.reflow", (ctx) => ({ pass: ctx.capabilities.reflow === true }), async (ctx) => {
		const sizeMatch = await ctx.queryWithSentinel("\x1B[18t", /\x1b\[8;(\d+);(\d+)t/);
		if (!sizeMatch) return {
			pass: false,
			note: "No XTWINOPS 18 response (can't report size)"
		};
		const cols = parseInt(sizeMatch[2], 10);
		ctx.write("\x1B[1;1H\x1B[2J");
		const longLine = "W".repeat(cols + 5);
		ctx.write(longLine);
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 2 && pos.col === 6,
			note: pos.row === 2 && pos.col === 6 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 2;6`
		};
	}),
	probe("extensions.semantic-prompts", (ctx) => ({ pass: ctx.capabilities.semanticPrompts === true }), async (ctx) => {
		ctx.write("\x1B]133;A\x07");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after OSC 133"
		};
	}),
	probe("extensions.osc2-title", (ctx) => {
		ctx.feed("\x1B]2;Test Title\x07");
		return { pass: ctx.getTitle().includes("Test Title") };
	}, async (ctx) => {
		ctx.write("\x1B]2;terminfo-test\x07");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B]2;\x07");
		return { pass: pos !== null };
	}),
	probe("extensions.osc0-icon-title", (ctx) => {
		ctx.feed("\x1B]0;My Title\x07");
		return { pass: ctx.getTitle().includes("My Title") };
	}, async (ctx) => {
		ctx.write("\x1B]0;test-title\x07");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B]0;\x07");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after OSC 0"
		};
	}),
	probe("extensions.osc52-clipboard", (ctx) => {
		const testData = btoa("terminfo-test");
		ctx.feed(`\x1b]52;c;${testData}\x07`);
		if (ctx.feedCapture("\x1B]52;c;?\x07").includes("52;c;")) return { pass: true };
		return {
			pass: false,
			note: "No OSC 52 query response"
		};
	}, async (ctx) => {
		const testData = btoa("terminfo-test");
		ctx.write(`\x1b]52;c;${testData}\x07`);
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No response after OSC 52"
		};
		return { pass: true };
	}),
	probe("extensions.osc52-write", (ctx) => {
		ctx.feed(`\x1b]52;c;${btoa("test")}\x07X`);
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		const testData = btoa("terminfo-write-test");
		ctx.write(`\x1b]52;c;${testData}\x07`);
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No response after OSC 52 write"
		};
		return { pass: true };
	}),
	probe("extensions.osc52-read", (ctx) => {
		const testData = btoa("terminfo-read-test");
		ctx.feed(`\x1b]52;c;${testData}\x07`);
		const response = ctx.feedCapture("\x1B]52;c;?\x07");
		return {
			pass: response.includes("52;c;"),
			note: response.includes("52;c;") ? void 0 : "No OSC 52 query response"
		};
	}, async (ctx) => {
		const testData = btoa("terminfo-read-test");
		ctx.write(`\x1b]52;c;${testData}\x07`);
		const match = await ctx.queryWithSentinel("\x1B]52;c;?\x07", /\x1b\]52;c;([^\x07\x1b]+)[\x07\x1b]/);
		if (!match) return {
			pass: false,
			note: "No OSC 52 read response"
		};
		return {
			pass: true,
			response: match[1]?.substring(0, 20)
		};
	}),
	oscColorQueryProbe("extensions.osc10-fg-color", 10),
	oscColorQueryProbe("extensions.osc11-bg-color", 11),
	probe("extensions.osc7-cwd", (ctx) => ({ pass: ctx.capabilities.extensions.has("osc7") }), async (ctx) => {
		ctx.write("\x1B]7;file:///tmp\x07");
		return { pass: await ctx.queryCursorPosition() !== null };
	}),
	probe("extensions.osc-633-vscode", (ctx) => ({ pass: ctx.capabilities.semanticPrompts === true }), async (ctx) => {
		ctx.write("\x1B]633;A\x07");
		ctx.write("\x1B]633;B\x07");
		ctx.write("\x1B]633;C\x07");
		ctx.write("\x1B]633;D;0\x07");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after OSC 633"
		};
	}),
	probe("extensions.osc133-a", (ctx) => {
		ctx.feed("\x1B]133;A\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]133;A\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 133;A"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 133;A may not be consumed)`
		};
	}),
	probe("extensions.osc133-b", (ctx) => {
		ctx.feed("\x1B]133;B\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]133;B\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 133;B"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 133;B may not be consumed)`
		};
	}),
	probe("extensions.osc133-c", (ctx) => {
		ctx.feed("\x1B]133;C\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]133;C\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 133;C"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 133;C may not be consumed)`
		};
	}),
	probe("extensions.osc133-d", (ctx) => {
		ctx.feed("\x1B]133;D;0\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]133;D;0\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 133;D"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 133;D may not be consumed)`
		};
	}),
	probe("extensions.osc133-p", (ctx) => {
		ctx.feed("\x1B]133;P;Cwd=/tmp\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]133;P;Cwd=/tmp\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 133;P"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 133;P may not be consumed)`
		};
	}),
	probe("extensions.osc633-a", (ctx) => {
		ctx.feed("\x1B]633;A\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;A\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;A"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;A may not be consumed)`
		};
	}),
	probe("extensions.osc633-b", (ctx) => {
		ctx.feed("\x1B]633;B\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;B\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;B"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;B may not be consumed)`
		};
	}),
	probe("extensions.osc633-c", (ctx) => {
		ctx.feed("\x1B]633;C\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;C\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;C"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;C may not be consumed)`
		};
	}),
	probe("extensions.osc633-d", (ctx) => {
		ctx.feed("\x1B]633;D;0\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;D;0\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;D"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;D may not be consumed)`
		};
	}),
	probe("extensions.osc633-e", (ctx) => {
		ctx.feed("\x1B]633;E;ls -la;nonce123\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;E;ls -la;nonce123\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;E"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;E may not be consumed)`
		};
	}),
	probe("extensions.osc633-p", (ctx) => {
		ctx.feed("\x1B]633;P;Cwd=/tmp\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]633;P;Cwd=/tmp\x07X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 633;P"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2 (OSC 633;P may not be consumed)`
		};
	}),
	probe("extensions.notifications", (ctx) => ({ pass: ctx.capabilities.extensions.has("osc9") }), async (ctx) => {
		ctx.write("\x1B]9;Test\x07");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after OSC 9"
		};
	}),
	probe("extensions.iterm2-images", (ctx) => ({ pass: ctx.capabilities.extensions.has("iterm2Images") }), async (ctx) => {
		ctx.write("\x1B]1337;File=inline=1:AAAA\x07");
		const pos = await ctx.queryCursorPosition();
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after OSC 1337"
		};
	}),
	probe("extensions.osc1337-cellsize", (ctx) => {
		const match = ctx.feedCapture("\x1B]1337;ReportCellSize\x07").match(/\x1b\]1337;ReportCellSize=(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)/);
		if (!match) return {
			pass: false,
			note: "No ReportCellSize response"
		};
		return {
			pass: true,
			note: `${match[1]}x${match[2]} pixels`
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]1337;ReportCellSize\x07", /\x1b\]1337;ReportCellSize=(\d+(?:\.\d+)?);(\d+(?:\.\d+)?)[\x07\x1b]/);
		if (!match) return {
			pass: false,
			note: "No ReportCellSize response"
		};
		return {
			pass: true,
			note: `${match[1]}x${match[2]} pixels`
		};
	}),
	probe("extensions.osc1337-capabilities", (ctx) => {
		const match = ctx.feedCapture("\x1B]1337;RequestCapabilities\x07").match(/\x1b\]1337;Capabilities=([^\x07\x1b]*)/);
		if (!match) return {
			pass: false,
			note: "No Capabilities response"
		};
		return {
			pass: true,
			response: match[1]
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]1337;RequestCapabilities\x07", /\x1b\]1337;Capabilities=([^\x07\x1b]*)[\x07\x1b]/);
		if (!match) return {
			pass: false,
			note: "No Capabilities response"
		};
		return {
			pass: true,
			response: match[1]
		};
	}),
	probe("extensions.osc9-progress", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]9;4;1;50\x07");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B]9;4;0\x07");
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc66-text-sizing", (ctx) => {
		const response = ctx.feedCapture("\x1B]66;?\x07");
		const pass = /\x1b\]66;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 66 query response"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]66;?\x07", /\x1b\]66;([^\x07\x1b]*)[\x07\x1b]/);
		if (match) return {
			pass: true,
			response: match[1]
		};
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]66;s=2\x07");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B]66;s=1\x07");
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? "Consumed (no query)" : "Not recognized"
		};
	}),
	probe("extensions.osc5522-clipboard", (ctx) => {
		const response = ctx.feedCapture("\x1B]5522;?\x07");
		if (/\x1b\]5522;/.test(response)) return {
			pass: true,
			response
		};
		return {
			pass: false,
			note: "No OSC 5522 response"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]5522;?\x07", /\x1b\]5522;([^\x07\x1b]*)[\x07\x1b]/);
		if (match) return {
			pass: true,
			response: match[1]
		};
		return {
			pass: false,
			note: "No OSC 5522 response"
		};
	}),
	probe("extensions.osc1-icon", (ctx) => {
		ctx.feed("\x1B]1;test-icon\x07");
		return {
			pass: true,
			note: ctx.getTitle().includes("test-icon") ? "title changed" : "consumed"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]1;terminfo-icon-test\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 1"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc4-palette", (ctx) => {
		const response = ctx.feedCapture("\x1B]4;0;?\x07");
		const pass = /\x1b\]4;0;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 4 response"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]4;0;?\x07", /\x1b\]4;0;([^\x07\x1b]+)[\x07\x1b]/);
		if (!match) return {
			pass: false,
			note: "No OSC 4 response"
		};
		return {
			pass: true,
			response: match[1]
		};
	}),
	probe("extensions.osc5-special-color", (ctx) => {
		const response = ctx.feedCapture("\x1B]5;0;?\x07");
		const pass = /\x1b\]5;0;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 5 response"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]5;0;?\x07", /\x1b\]5;0;([^\x07\x1b]+)[\x07\x1b]/);
		if (!match) return {
			pass: false,
			note: "No OSC 5 response"
		};
		return {
			pass: true,
			response: match[1]
		};
	}),
	oscColorQueryProbe("extensions.osc12-cursor-color", 12),
	probe("extensions.osc104-reset-palette", (ctx) => {
		ctx.feed("\x1B]4;0;rgb:ff/00/00\x07");
		ctx.feed("\x1B]104;0\x07");
		const response = ctx.feedCapture("\x1B]4;0;?\x07");
		const pass = /\x1b\]4;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 4 query response (cannot verify reset)"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]104\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 104"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("extensions.osc110-reset-fg", (ctx) => {
		ctx.feed("\x1B]110\x07");
		const response = ctx.feedCapture("\x1B]10;?\x07");
		const pass = /\x1b\]10;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 10 response (cannot verify reset support)"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]110\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 110"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("extensions.osc111-reset-bg", (ctx) => {
		ctx.feed("\x1B]111\x07");
		const response = ctx.feedCapture("\x1B]11;?\x07");
		const pass = /\x1b\]11;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 11 response (cannot verify reset support)"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]111\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 111"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("extensions.osc112-reset-cursor", (ctx) => {
		ctx.feed("\x1B]112\x07");
		const response = ctx.feedCapture("\x1B]12;?\x07");
		const pass = /\x1b\]12;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 12 response (cannot verify reset support)"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]112\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 112"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("extensions.osc117-reset-highlight-bg", (ctx) => {
		ctx.feed("\x1B]117\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]117\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 117"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	probe("extensions.osc119-reset-highlight-fg", (ctx) => {
		ctx.feed("\x1B]119\x07X");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "X",
			note: cell.char === "X" ? void 0 : `cell at 0,0 is "${cell.char}", expected "X"`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]119\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 119"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1`
		};
	}),
	oscColorQueryProbe("extensions.osc17-highlight-bg", 17),
	oscColorQueryProbe("extensions.osc19-highlight-fg", 19),
	probe("extensions.osc22-pointer", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]22;pointer\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 22"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc99-kitty-notify", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]99;i=1:d=0:p=body;test\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 99"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc777-notify", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]777;notify;test;body\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 777"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc666-termprop", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]666;test-prop=value\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 666"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc3008-context", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]3008;type=test\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 3008"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc113-reset-pointer-fg", pointerColorResetProbe(13, 113, /\x1b\]13;rgb:ffff\/ffff\/ffff/), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]113\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 113"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc114-reset-pointer-bg", pointerColorResetProbe(14, 114, /\x1b\]14;rgb:0000\/0000\/0000/), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]114\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 114"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc21-kitty-color", (ctx) => {
		const response = ctx.feedCapture("\x1B]21;foreground=?\x07");
		const pass = /\x1b\]21;/.test(response);
		return {
			pass,
			note: pass ? void 0 : "No OSC 21 response"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B]21;foreground=?\x07", /\x1b\]21;([^\x07\x1b]*)[\x07\x1b]/);
		if (match) return {
			pass: true,
			response: match[1]
		};
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]21;foreground=?\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 21"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? "Consumed (no query response)" : `cursor at col ${pos.col}`
		};
	}),
	probe("extensions.osc30001-color-stack-push", colorStackProbe(), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]30001\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 30001"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc30101-color-stack-pop", colorStackProbe(), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]30001\x07");
		ctx.write("\x1B]30101\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 30101"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc176-app-id", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]176;terminfo-test\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 176"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc555-flash", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]555\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 555"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc440-audio", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]440;bell.wav\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 440"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc7770-font-size", oscQueryProbe("\x1B]7770;?\x07", /\x1b\]7770;[0-9]+/, "No OSC 7770 font-size response"), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]7770;?\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 7770"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc7777-font-window-size", oscQueryProbe("\x1B]7777;?\x07", /\x1b\]7777;[0-9]+/, "No OSC 7777 font/window-size response"), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]7777;;\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 7777"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc701-locale", oscQueryProbe("\x1B]701;?\x07", /\x1b\]701;[A-Za-z0-9_.-]+/, "No OSC 701 locale response"), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]701;?\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 701"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc702-version", oscQueryProbe("\x1B]702\x07", /\x1b\]702;[^\x07\x1b]+/, "No OSC 702 version response"), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]702\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 702"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc710-font-normal", null, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]710;fixed\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 710"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc720-scroll-up", osc720ScrollProbe(), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]720\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 720"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.osc776-cell-size", oscQueryProbe("\x1B]776\x07", /\x1b\]776;\d+;\d+;\d+/, "No OSC 776 cell-size response"), async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B]776\x07");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after OSC 776"
		};
		return {
			pass: pos.col === 1,
			note: pos.col === 1 ? void 0 : `cursor at col ${pos.col}, expected 1 (OSC may have been printed)`
		};
	}),
	probe("extensions.sixel-da1", (ctx) => {
		const response = ctx.feedCapture("\x1B[c");
		const pass = /;4[;c]/.test(response);
		return {
			pass,
			note: pass ? void 0 : "DA1 response missing attribute 4 (sixel)"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[c", /\x1b\[\?([0-9;]+)c/);
		if (!match) return {
			pass: false,
			note: "No DA1 response"
		};
		const pass = match[1].split(";").includes("4");
		return {
			pass,
			note: pass ? `DA1 attrs: ${match[1]}` : `DA1 attrs: ${match[1]} (no sixel)`
		};
	}),
	probe("extensions.sixel-geometry-report", (ctx) => {
		const response = ctx.feedCapture("\x1B[?1;1;0S");
		if (/\x1b\[\?1;[0-9;]+S/.test(response)) return {
			pass: true,
			response,
			note: "Sixel geometry response received"
		};
		const probeResponse = ctx.feedCapture("\x1B[c");
		return {
			pass: /\x1b\[\?[0-9;]+c/.test(probeResponse) && !response.includes("?1;1;0S"),
			note: /\x1b\[\?[0-9;]+c/.test(probeResponse) ? "Sequence consumed; terminal responsive (no sixel geometry response)" : "Terminal unresponsive after CSI ? 1 ; 1 ; 0 S"
		};
	}, async (ctx) => {
		const match = await ctx.queryWithSentinel("\x1B[?1;1;0S", /\x1b\[\?1;([0-9;]+)S/, 1e3);
		if (match) return {
			pass: true,
			response: match[0],
			note: `geometry: ${match[1]}`
		};
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No response after sixel geometry query"
		};
		return {
			pass: false,
			note: "Sequence consumed but no sixel geometry response"
		};
	})
];
//#endregion
//#region src/input.ts
/** Mouse input probe — enable mode, check getMode (termless) or cursor response (term), disable. */
function mouseInputProbe(id, modeCode, modeName, label) {
	const enableSeq = `\x1b[?${modeCode}h`;
	const disableSeq = `\x1b[?${modeCode}l`;
	return probe(id, (ctx) => {
		ctx.feed(enableSeq);
		const pass = ctx.getMode(modeName) === true;
		ctx.feed(disableSeq);
		return { pass };
	}, async (ctx) => {
		ctx.write(enableSeq);
		const pos = await ctx.queryCursorPosition();
		ctx.write(disableSeq);
		return {
			pass: pos !== null,
			note: pos ? void 0 : `No cursor response after enabling ${label}`
		};
	});
}
const inputProbes = [
	probe("input.modify-other-keys", (ctx) => ({ pass: ctx.capabilities.extensions.has("modifyOtherKeys") }), async (ctx) => {
		ctx.write("\x1B[>4;2m");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[>4;0m");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after enabling modifyOtherKeys"
		};
	}),
	probe("input.csi-u", (ctx) => ({ pass: ctx.capabilities.kittyKeyboard === true }), async (ctx) => {
		ctx.write("\x1B[>1u");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[<u");
		return {
			pass: pos !== null,
			note: pos ? void 0 : "No cursor response after enabling CSI u mode"
		};
	}),
	mouseInputProbe("input.pixel-mouse", 1016, "pixelMouse", "pixel mouse"),
	mouseInputProbe("input.urxvt-mouse", 1015, "mouseTracking", "urxvt mouse"),
	mouseInputProbe("input.x10-mouse", 9, "mouseTracking", "X10 mouse"),
	probe("input.modify-other-keys-3", (ctx) => {
		ctx.feed("\x1B[>4;3m");
		const pass = ctx.capabilities.extensions.has("modifyOtherKeys");
		ctx.feed("\x1B[>4;0m");
		return {
			pass,
			note: pass ? void 0 : "modifyOtherKeys not supported"
		};
	}, async (ctx) => {
		ctx.write("\x1B[>4;3m");
		const pos = await ctx.queryCursorPosition();
		ctx.write("\x1B[>4;0m");
		if (!pos) return {
			pass: false,
			note: "No cursor response after enabling modifyOtherKeys 3"
		};
		return { pass: true };
	}),
	mouseInputProbe("input.button-event-mouse", 1002, "mouseTracking", "button-event mouse")
];
//#endregion
//#region src/reset.ts
const resetProbes = [
	probe("reset.sgr", (ctx) => {
		ctx.feed("\x1B[1;3;7mX\x1B[0mY");
		const cell = ctx.getCell(0, 1);
		return { pass: cell.bold === false && cell.italic === false && !cell.underline };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B[1m");
		ctx.write("\x1B[0m");
		ctx.write("X");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("reset.ris", (ctx) => {
		ctx.feed("Hello World");
		ctx.feed("\x1Bc");
		return { pass: ctx.getCursor().x === 0 && ctx.getCursor().y === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1Bc");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after RIS"
		};
		return {
			pass: pos.row === 1 && pos.col === 1,
			note: pos.row === 1 && pos.col === 1 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 1;1`
		};
	}),
	probe("reset.soft", (ctx) => {
		ctx.feed("\x1B[?1h");
		ctx.feed("Hello");
		ctx.feed("\x1B[!p");
		return { pass: ctx.getMode("applicationCursor") === false };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[!p");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response after DECSTR"
		};
		return { pass: true };
	}),
	probe("reset.decaln", (ctx) => {
		ctx.feed("\x1B#8");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char === "E",
			note: cell.char === "E" ? void 0 : `cell (0,0) char='${cell.char}', expected 'E'`
		};
	}, async (ctx) => {
		ctx.write("\x1B#8");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after DECALN"
		};
		return {
			pass: pos.row === 1 && pos.col === 1,
			note: pos.row === 1 && pos.col === 1 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 1;1`
		};
	}),
	probe("reset.method", (ctx) => {
		ctx.feed("Hello World");
		ctx.reset();
		return { pass: ctx.getCursor().x === 0 && ctx.getCursor().y === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[!p");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after DECSTR"
		};
		return {
			pass: true,
			note: `cursor at ${pos.row};${pos.col} after DECSTR`
		};
	})
];
//#endregion
//#region src/scrollback.ts
const scrollbackProbes = [
	probe("scrollback.accumulate", (ctx) => {
		for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`);
		return { pass: ctx.getScrollback().totalLines > 24 };
	}, async (ctx) => {
		const sizeMatch = await ctx.queryWithSentinel("\x1B[18t", /\x1b\[8;(\d+);(\d+)t/);
		const rows = sizeMatch ? parseInt(sizeMatch[1], 10) : 24;
		ctx.write("\x1B[2J\x1B[H");
		const lineCount = rows + 10;
		for (let i = 0; i < lineCount; i++) ctx.write(`line-${i}\n`);
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row <= rows,
			note: pos.row <= rows ? void 0 : `cursor at row ${pos.row}, expected <= ${rows}`
		};
	}),
	probe("scrollback.total-lines", (ctx) => {
		for (let i = 0; i < 30; i++) ctx.feed(`line ${i}\r\n`);
		return { pass: ctx.getScrollback().totalLines >= 30 };
	}, async (ctx) => {
		ctx.write("\x1B[2J\x1B[H");
		for (let i = 0; i < 30; i++) ctx.write(`total-${i}\n`);
		ctx.write("\x1B[5;1H");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: true,
			note: "Content written to scrollback"
		};
	}),
	probe("scrollback.scroll-up", (ctx) => {
		ctx.feed("TOP\r\n");
		for (let i = 0; i < 23; i++) ctx.feed("line\r\n");
		ctx.feed("\x1B[S");
		return { pass: ctx.getCell(0, 0).char !== "T" };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[1S");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after SU"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("scrollback.reverse-index", (ctx) => {
		ctx.feed("A\r\nB\r\nC");
		ctx.feed("\x1B[H\x1BM");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[1;5H");
		ctx.write("\x1BM");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after RI"
		};
		return {
			pass: pos.row === 1 && pos.col === 5,
			note: pos.row === 1 && pos.col === 5 ? void 0 : `got ${pos.row};${pos.col}, expected 1;5`
		};
	}),
	probe("scrollback.scroll-down", (ctx) => {
		ctx.feed("LINE1\r\nLINE2\r\nLINE3");
		ctx.feed("\x1B[T");
		return { pass: isBlank(ctx.getCell(0, 0).char) };
	}, async (ctx) => {
		ctx.write("\x1B[5;5H");
		ctx.write("\x1B[1T");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response after SD"
		};
		return {
			pass: pos.row === 5 && pos.col === 5,
			note: pos.row === 5 && pos.col === 5 ? void 0 : `cursor at ${pos.row};${pos.col}, expected 5;5`
		};
	}),
	probe("scrollback.set-region", (ctx) => {
		ctx.feed("\x1B[5;10r");
		const cursor = ctx.getCursor();
		ctx.feed("\x1B[r");
		return { pass: cursor.x === 0 && cursor.y === 0 };
	}, async (ctx) => {
		ctx.write("\x1B[5;10r");
		ctx.write("\x1B[r");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response after DECSTBM"
		};
		return { pass: true };
	}),
	probe("scrollback.alt-screen", (ctx) => {
		ctx.feed("NORMAL");
		ctx.feed("\x1B[?1049h");
		return { pass: ctx.getMode("altScreen") === true };
	}, async (ctx) => {
		ctx.write("\x1B[2J\x1B[H");
		ctx.write("MAIN_SCREEN_MARKER");
		const pos1 = await ctx.queryCursorPosition();
		if (!pos1) return {
			pass: false,
			note: "No cursor response"
		};
		ctx.write("\x1B[?1049h");
		ctx.write("\x1B[2J\x1B[H");
		ctx.write("ALT_SCREEN");
		ctx.write("\x1B[?1049l");
		const pos2 = await ctx.queryCursorPosition();
		if (!pos2) return {
			pass: false,
			note: "No cursor response after alt screen exit"
		};
		return {
			pass: pos2.row === pos1.row && pos2.col === pos1.col,
			note: pos2.row === pos1.row && pos2.col === pos1.col ? void 0 : `cursor at ${pos2.row};${pos2.col}, expected ${pos1.row};${pos1.col}`
		};
	}),
	probe("scrollback.decstbm", (ctx) => {
		ctx.feed("FIXED_TOP\r\n");
		ctx.feed("\x1B[3;10r");
		ctx.feed("\x1B[3;1H");
		for (let i = 0; i < 20; i++) ctx.feed(`scroll-${i}\r\n`);
		const cell = ctx.getCell(0, 0);
		const pass = cell.char === "F";
		ctx.feed("\x1B[r");
		return {
			pass,
			note: pass ? void 0 : `row 0 char='${cell.char}', expected 'F'`
		};
	}, async (ctx) => {
		ctx.write("\x1B[2J\x1B[H");
		ctx.write("FIXED_TOP\r\n");
		ctx.write("\x1B[3;10r");
		ctx.write("\x1B[3;1H");
		for (let i = 0; i < 20; i++) ctx.write(`scroll-${i}\r\n`);
		ctx.write("\x1B[r");
		if (!await ctx.queryCursorPosition()) return {
			pass: false,
			note: "No cursor response"
		};
		return { pass: true };
	}),
	probe("scrollback.decstbm-reset", (ctx) => {
		ctx.feed("\x1B[5;10r");
		ctx.feed("\x1B[r");
		ctx.feed("\x1B[H");
		for (let i = 0; i < 30; i++) ctx.feed(`line-${i}\r\n`);
		const scroll = ctx.getScrollback();
		return {
			pass: scroll.totalLines > 24,
			note: scroll.totalLines > 24 ? void 0 : `totalLines=${scroll.totalLines}, expected >24 (full-screen scrolling)`
		};
	}, async (ctx) => {
		ctx.write("\x1B[5;10r");
		ctx.write("\x1B[r");
		ctx.write("\x1B[H");
		ctx.write("\x1B[999B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row >= 20,
			note: `cursor at row ${pos.row} (expected near bottom after DECSTBM reset)`,
			response: `${pos.row};${pos.col}`
		};
	})
];
//#endregion
//#region src/charsets.ts
const charsetsProbes = [
	probe("charsets.dec-special", (ctx) => {
		ctx.feed("\x1B(0q\x1B(B");
		return { pass: ctx.getCell(0, 0).char !== "q" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B(0");
		ctx.write("q");
		ctx.write("\x1B(B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("charsets.utf8", (ctx) => {
		ctx.feed("é");
		const pass1 = ctx.getCell(0, 0).char === "é";
		ctx.feed("\x1B[1G世");
		const pass2 = ctx.getCell(0, 0).char === "世";
		return { pass: pass1 && pass2 };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("é");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("charsets.g0-g1-switching", (ctx) => {
		ctx.feed("\x1B(0");
		ctx.feed("l");
		ctx.feed("\x1B(B");
		const cell = ctx.getCell(0, 0);
		return {
			pass: cell.char !== "l",
			note: cell.char !== "l" ? `rendered as '${cell.char}'` : "rendered as literal 'l', expected box-drawing"
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B(0");
		ctx.write("l");
		ctx.write("\x1B(B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 2,
			note: pos.col === 2 ? void 0 : `cursor at col ${pos.col}, expected 2`
		};
	}),
	probe("charsets.dec-line-drawing", (ctx) => {
		ctx.feed("\x1B(0");
		ctx.feed("jklmqx");
		ctx.feed("\x1B(B");
		const chars = [
			ctx.getCell(0, 0).char,
			ctx.getCell(0, 1).char,
			ctx.getCell(0, 2).char,
			ctx.getCell(0, 3).char,
			ctx.getCell(0, 4).char,
			ctx.getCell(0, 5).char
		];
		const allMapped = chars.every((c, i) => c !== "jklmqx"[i]);
		return {
			pass: allMapped,
			note: allMapped ? `rendered: ${chars.join("")}` : `some chars not mapped: ${chars.join("")}`
		};
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("\x1B(0");
		ctx.write("jklmqx");
		ctx.write("\x1B(B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 7,
			note: pos.col === 7 ? void 0 : `cursor at col ${pos.col}, expected 7`
		};
	})
];
//#endregion
//#region src/unicode.ts
const unicodeProbes = [
	probe("unicode.east-asian-ambiguous", (ctx) => {
		ctx.feed("●X");
		const c1 = ctx.getCell(0, 1);
		const c2 = ctx.getCell(0, 2);
		return { pass: c1.char === "X" || c2.char === "X" };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("●");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 1 || width === 2,
			note: `width=${width} (ambiguous chars vary by terminal/locale)`,
			response: String(width)
		};
	}),
	probe("unicode.grapheme-cursor", (ctx) => {
		ctx.feed("👨‍👩‍👧X");
		return { pass: ctx.getText().includes("X") };
	}, async (ctx) => {
		const width = await ctx.measureRenderedWidth("👨‍👩‍👧");
		if (width === null) return {
			pass: false,
			note: "Cannot measure width"
		};
		return {
			pass: width === 2,
			note: width === 2 ? void 0 : `width=${width}, expected 2`
		};
	}),
	probe("unicode.wrap-boundary", (ctx) => {
		ctx.feed("A".repeat(79) + "中");
		return { pass: ctx.getCell(1, 0).char === "中" };
	}, async (ctx) => {
		const cols = ctx.cols;
		ctx.write("\x1B[1;1H\x1B[2J");
		ctx.write("A".repeat(cols - 1));
		ctx.write("中");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.row === 2,
			note: pos.row === 2 ? void 0 : `cursor at row ${pos.row}, expected 2 (wide char should wrap)`
		};
	}),
	probe("unicode.tab-stops", (ctx) => {
		ctx.feed("A	B");
		return { pass: ctx.getCell(0, 8).char === "B" };
	}, async (ctx) => {
		ctx.write("\x1B[1;1H\x1B[2K");
		ctx.write("A	B");
		const pos = await ctx.queryCursorPosition();
		if (!pos) return {
			pass: false,
			note: "No cursor response"
		};
		return {
			pass: pos.col === 10,
			note: pos.col === 10 ? void 0 : `cursor at col ${pos.col}, expected 10 (A + tab to 9 + B)`
		};
	})
];
//#endregion
//#region src/index.ts
const ALL_PROBES = [
	...extensionsProbes,
	...sgrProbes,
	...cursorProbes,
	...textProbes,
	...eraseProbes,
	...editingProbes,
	...modesProbes,
	...deviceProbes,
	...inputProbes,
	...resetProbes,
	...scrollbackProbes,
	...charsetsProbes,
	...unicodeProbes
];
//#endregion
export { ALL_PROBES, behavioralModeProbe, capabilityProbe, charsetsProbes, cursorProbe, cursorProbes, deviceProbes, editingProbes, eraseProbes, extensionsProbes, inputProbes, isBlank, modeProbe, modesProbes, probe, resetProbes, responseProbe, scrollbackProbes, sgrProbe, sgrProbes, textProbes, unicodeProbes, widthProbe };
