import { eslintCompatPlugin } from "@oxlint/plugins";

import { noArrayFilterMapRule } from "./rules/no-array-filter-map.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { noManualEffectErrorTagRule } from "./effect/rules/no-manual-effect-error-tag.ts";
import { noManualTagComparisonRule } from "./effect/rules/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./effect/rules/no-manual-tagged-construction.ts";
import { noServiceConstructorImportsRule } from "./effect/rules/no-service-constructor-imports.ts";
import { preferEffectMatchRule } from "./effect/rules/prefer-effect-match.ts";

/** Generic and Effect Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop" },
	rules: {
		"no-array-filter-map": noArrayFilterMapRule,
		"no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
		"no-chained-type-assertions": noChainedTypeAssertionsRule,
		"no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
		"no-known-value-widening": noKnownValueWideningRule,
		"no-module-mocking": noModuleMockingRule,
		"no-object-parameters": noObjectParametersRule,
		"no-reflect-apply": noReflectApplyRule,
		"no-reflect-get": noReflectGetRule,
		"no-runtime-typeof": noRuntimeTypeofRule,
		"no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
		"no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
		"no-unknown-parameters": noUnknownParametersRule,
		"no-unknown-returns": noUnknownReturnsRule,
		"no-unknown-type-aliases": noUnknownTypeAliasesRule,
		"no-widen-then-assert": noWidenThenAssertRule,
		"no-manual-effect-error-tag": noManualEffectErrorTagRule,
		"no-manual-tag-comparison": noManualTagComparisonRule,
		"no-manual-tagged-construction": noManualTaggedConstructionRule,
		"no-service-constructor-imports": noServiceConstructorImportsRule,
		"prefer-effect-match": preferEffectMatchRule,
	},
});

export default antiSlopPlugin;
