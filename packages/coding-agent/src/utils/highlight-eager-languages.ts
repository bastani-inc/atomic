/// <reference path="./highlight-js.d.ts" />
import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { registerBundledHighlightCore } from "./syntax-highlight.ts";

const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};

for (const [name, language] of Object.entries(eagerLanguages)) {
	if (!hljs.getLanguage(name)) {
		hljs.registerLanguage(name, language);
	}
}

registerBundledHighlightCore(hljs);
