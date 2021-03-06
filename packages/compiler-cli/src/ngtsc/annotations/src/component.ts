/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ConstantPool, Expression, R3ComponentMetadata, R3DirectiveMetadata, WrappedNodeExpr, compileComponentFromMetadata, makeBindingParser, parseTemplate} from '@angular/compiler';
import * as ts from 'typescript';

import {Decorator, ReflectionHost} from '../../host';
import {reflectObjectLiteral, staticallyResolve} from '../../metadata';
import {AnalysisOutput, CompileResult, DecoratorHandler} from '../../transform';

import {extractDirectiveMetadata} from './directive';
import {SelectorScopeRegistry} from './selector_scope';
import {isAngularCore} from './util';

const EMPTY_MAP = new Map<string, Expression>();

/**
 * `DecoratorHandler` which handles the `@Component` annotation.
 */
export class ComponentDecoratorHandler implements DecoratorHandler<R3ComponentMetadata> {
  constructor(
      private checker: ts.TypeChecker, private reflector: ReflectionHost,
      private scopeRegistry: SelectorScopeRegistry) {}

  detect(decorators: Decorator[]): Decorator|undefined {
    return decorators.find(decorator => decorator.name === 'Component' && isAngularCore(decorator));
  }

  analyze(node: ts.ClassDeclaration, decorator: Decorator): AnalysisOutput<R3ComponentMetadata> {
    if (decorator.args === null || decorator.args.length !== 1) {
      throw new Error(`Incorrect number of arguments to @Component decorator`);
    }
    const meta = decorator.args[0];
    if (!ts.isObjectLiteralExpression(meta)) {
      throw new Error(`Decorator argument must be literal.`);
    }

    // @Component inherits @Directive, so begin by extracting the @Directive metadata and building
    // on it.
    const directiveMetadata =
        extractDirectiveMetadata(node, decorator, this.checker, this.reflector);
    if (directiveMetadata === undefined) {
      // `extractDirectiveMetadata` returns undefined when the @Directive has `jit: true`. In this
      // case, compilation of the decorator is skipped. Returning an empty object signifies
      // that no analysis was produced.
      return {};
    }

    // Next, read the `@Component`-specific fields.
    const component = reflectObjectLiteral(meta);

    // Resolve and parse the template.
    if (!component.has('template')) {
      throw new Error(`For now, components must directly have a template.`);
    }
    const templateExpr = component.get('template') !;
    const templateStr = staticallyResolve(templateExpr, this.checker);
    if (typeof templateStr !== 'string') {
      throw new Error(`Template must statically resolve to a string: ${node.name!.text}`);
    }

    let preserveWhitespaces: boolean = false;
    if (component.has('preserveWhitespaces')) {
      const value = staticallyResolve(component.get('preserveWhitespaces') !, this.checker);
      if (typeof value !== 'boolean') {
        throw new Error(`preserveWhitespaces must resolve to a boolean if present`);
      }
      preserveWhitespaces = value;
    }

    const template = parseTemplate(
        templateStr, `${node.getSourceFile().fileName}#${node.name!.text}/template.html`,
        {preserveWhitespaces});
    if (template.errors !== undefined) {
      throw new Error(
          `Errors parsing template: ${template.errors.map(e => e.toString()).join(', ')}`);
    }

    // If the component has a selector, it should be registered with the `SelectorScopeRegistry` so
    // when this component appears in an `@NgModule` scope, its selector can be determined.
    if (directiveMetadata.selector !== null) {
      this.scopeRegistry.registerSelector(node, directiveMetadata.selector);
    }

    return {
      analysis: {
        ...directiveMetadata,
        template,
        viewQueries: [],

        // These will be replaced during the compilation step, after all `NgModule`s have been
        // analyzed and the full compilation scope for the component can be realized.
        pipes: EMPTY_MAP,
        directives: EMPTY_MAP,
      }
    };
  }

  compile(node: ts.ClassDeclaration, analysis: R3ComponentMetadata): CompileResult {
    const pool = new ConstantPool();

    // Check whether this component was registered with an NgModule. If so, it should be compiled
    // under that module's compilation scope.
    const scope = this.scopeRegistry.lookupCompilationScope(node);
    if (scope !== null) {
      // Replace the empty components and directives from the analyze() step with a fully expanded
      // scope. This is possible now because during compile() the whole compilation unit has been
      // fully analyzed.
      analysis = {...analysis, ...scope};
    }

    const res = compileComponentFromMetadata(analysis, pool, makeBindingParser());
    return {
      name: 'ngComponentDef',
      initializer: res.expression,
      statements: pool.statements,
      type: res.type,
    };
  }
}
