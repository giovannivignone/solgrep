'use strict';
/**
 * @author github.com/tintinweb
 * @license MIT
 * */
/** IMPORT */

const fs = require('fs');
const path = require('path');
const parser = require('@solidity-parser/parser');
const { memberAccesses, identifiers } = require('./utils/macros');
const { typicalLibraryNames } = require('./utils/typical-library-names');
const { getFunctionNameFromNode } = require('./utils/helpers');

class FindOneExit extends Error {}

const prxAttribForwarder = {
  get: function (target, prop, receiver) {
    return target[prop] === undefined ? target.ast[prop] : target[prop];
  },
};

class SourceUnit {
  constructor() {
    this.filePath = undefined;
    this.ast = undefined;
    this.content = undefined;
    this.contracts = {};
    this.pragmas = [];
    this.imports = [];
  }

  /**
   * @returns {string} - the source code of the source unit
   */
  getSource() {
    return this.content;
  }

  /**
   *
   * @returns {Contract[]}
   */
  getContracts() {
    return Object.values(this.contracts);
  }

  /**
   * @param {string} fpath - the path to the file
   * @returns {object} - {filePath, content}
   * */
  static getFileContent(fpath) {
    if (!fs.existsSync(fpath)) {
      throw Error(`File '${fpath}' does not exist.`);
    }
    const filePath = path.resolve(fpath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filePath, content };
  }

  /**
   * @returns the AST of the source unit
   * */
  toJSON() {
    return this.ast;
  }

  /**
   * @returns {SourceUnit} - a clone of the current SourceUnit
   * */
  clone() {
    return Object.assign(new SourceUnit(this.workspace), this);
  }

  /**
   * @param {string} fpath - the path to the file
   * @returns {SourceUnit} - the source unit
   */
  fromFile(fpath) {
    const { filePath, content } = SourceUnit.getFileContent(fpath); // returns {fpath, content}
    this.filePath = filePath;
    this.fromSource(content);
    return this;
  }

  /**
   * @param {string} content
   * */
  fromSource(content) {
    /** parser magic */
    this.content = content;
    this.parseAst(content);
  }

  /**
   * @param {string} input - the source code
   * @returns {SourceUnit} - the source unit
   */
  parseAst(input) {
    this.ast = parser.parse(input, { loc: true, tolerant: true });

    if (typeof this.ast === 'undefined') {
      throw new parser.ParserError('Parser failed to parse file.');
    }

    /** AST rdy */

    var this_sourceUnit = this;

    parser.visit(this.ast, {
      PragmaDirective(node) {
        this_sourceUnit.pragmas.push(node);
      },
      ImportDirective(node) {
        this_sourceUnit.imports.push(node);
      },
      ContractDefinition(node) {
        this_sourceUnit.contracts[node.name] = new Proxy(
          new Contract(this_sourceUnit, node),
          prxAttribForwarder
        );
      },
    });
    /*** also import dependencies? */
    return this;
  }
}

class Contract {
  constructor(sourceUnit, node) {
    this.sourceUnit = sourceUnit;
    this.ast = node;
    this.name = node.name;
    this.dependencies = node.baseContracts.map(
      (spec) => spec.baseName.namePath
    );

    this.stateVars = {}; // pure statevars --> see names
    this.enums = {}; // enum declarations
    this.structs = {}; // struct declarations
    this.mappings = {}; // mapping declarations
    this.modifiers = {}; // modifier declarations
    this.functions = []; // function and method declarations; can be overloaded
    this.constructor = null; // ...
    this.fallback = null; // ...
    this.receiveEther = null; // ...
    this.events = []; // event declarations; can be overloaded
    this.inherited_names = {}; // all names inherited from other contracts
    this.names = {}; // all names in current contract (methods, events, structs, ...)
    this.usingFor = {}; // using XX for YY

    this.functionCalls = [];

    this._processAst(node);
  }

  /**
   * @returns {FunctionDef[]} - the functions of the contract
   * */
  getFunctions() {
    return this.functions;
  }

  /**
   * @returns - the AST of the contract
   * */
  toJSON() {
    return this.ast;
  }

  /**
   * @returns {string} - the source code of the contract
   * */
  getSource() {
    return this.sourceUnit.content
      .split('\n')
      .slice(this.ast.loc.start.line - 1, this.ast.loc.end.line)
      .join('\n');
  }

  _processAst(node) {
    var current_function = null;
    let current_contract = this;

    parser.visit(node, {
      StateVariableDeclaration(_node) {
        parser.visit(_node, {
          VariableDeclaration(__node) {
            __node.extra = { usedAt: [] };
            current_contract.stateVars[__node.name] = __node;
            current_contract.names[__node.name] = __node;
          },
        });
      },
      // --> is a subtype. Mapping(_node){current_contract.mappings[_node.name]=_node},
      Mapping(_node) {
        current_contract.mappings[_node.name] = _node;
      },
      EnumDefinition(_node) {
        current_contract.enums[_node.name] = _node;
        current_contract.names[_node.name] = _node;
      },
      StructDefinition(_node) {
        current_contract.structs[_node.name] = _node;
        current_contract.names[_node.name] = _node;
      },
      UsingForDeclaration(_node) {
        current_contract.usingFor[_node.libraryName] = _node;
      },
      ConstructorDefinition(_node) {
        current_contract.constructor = _node;
        current_contract.names[_node.name] = _node;
      }, // wrong def in code: https://github.com/solidityj/solidity-antlr4/blob/fbe865f8ba510cbdb1540fcf9517a42820a4d097/Solidity.g4#L78 for consttuctzor () ..
      ModifierDefinition(_node) {
        current_function = new FunctionDef(current_contract, _node, 'modifier');
        current_contract.modifiers[_node.name] = current_function;
        current_contract.names[_node.name] = current_function;
      },
      EventDefinition(_node) {
        current_function = {
          _node: _node,
          name: _node.name,
          arguments: {}, // declarations: quick access to argument list
          declarations: {}, // all declarations: arguments+returns+body
        };
        current_contract.events.push(current_function);

        current_contract.names[_node.name] = current_function;
        // parse function body to get all function scope params.
        // first get declarations
        parser.visit(_node.parameters, {
          VariableDeclaration: function (__node) {
            current_function.arguments[__node.name] = __node;
            current_function.declarations[__node.name] = __node;
          },
        });
      },
      FunctionDefinition(_node) {
        let newFunc = new Proxy(
          new FunctionDef(current_contract, _node),
          prxAttribForwarder
        );
        current_contract.functions.push(newFunc);
        current_contract.names[_node.name] = newFunc;
      },

      FunctionCall(__node) {
        current_contract.functionCalls.push(__node);
      },
    });
  }
}

class FunctionDef {
  constructor(contract, node) {
    this.contract = contract;
    this.ast = node;

    if (this.ast.isConstructor) {
      contract.constructor = this;
      this.name = '__constructor__';
    } else if (this.ast.isFallback) {
      contract.fallback = this;
      this.name = '__fallback__';
    } else if (this.ast.isReceiveEther) {
      contract.receiveEther = this;
      this.name = '__receiveEther__';
    } else {
      this.name = node.name;
    }

    if (
      this.ast.isConstructor ||
      !this.ast.modifiers ||
      !this.ast.modifiers.length
    ) {
      this.modifiers = {};
    } else {
      this.modifiers = this.ast.modifiers.reduce(
        (a, v) => ({ ...a, [v.name]: v }),
        {}
      );
    }
  }

  /**
   * @returns {string}
   */
  getName() {
    return this.name;
  }

  /**
   * Retrieves the modifiers applied to the function definition.
   * @returns {object} An object containing all the modifiers of the function,
   * where each key is the name of a modifier and the corresponding value is the modifier's node.
   */
  getModifiers() {
    return this.modifiers;
  }

  /**
   * @returns {string} - the source code of the function
   * */
  getSource() {
    return this.contract.sourceUnit.content
      .split('\n')
      .slice(this.ast.loc.start.line - 1, this.ast.loc.end.line)
      .join('\n');
  }

  /**
   * @param {string} funcName - the name of the function this function may call to
   * @returns {boolean} - true if the function makes a call to funcName
   * */
  callsTo(funcName) {
    return !!this.getFunctionCalls(funcName, { findOne: true }).length;
  }

  getFunctionNameFromNode(node) {
    return getFunctionNameFromNode(node);
  }

  getFunctionSourcePathFromNode(node, repoMapping) {
    const name = getFunctionNameFromNode(node);
    for (const [path, content] of Object.entries(repoMapping)) {
      if (content.includes(name)) {
        const contractSourceUnit = new SourceUnit();
        contractSourceUnit.fromSource(content);
        for (let contract of contractSourceUnit.getContracts()) {
          for (let func of contract.getFunctions()) {
            if (func.getName() === name) {
              return path;
            }
          }
        }
      }
    }
    return null;
  }

  /**
   * @param {string} funcName - the name of the function this function may call to
   * @param {object} opts - options
   * @param {boolean} opts.findOne - return after first match
   * @returns {FunctionCall[]} - array of function calls
   * */
  getFunctionCalls(funcName, opts) {
    let found = [];
    opts = opts || {};
    try {
      parser.visit(this.ast, {
        FunctionCall(node) {
          switch (node.expression.type) {
            case 'MemberAccess':
              if (node.expression.memberName === funcName) {
                found.push(node);
              }
              break;
            case 'Identifier':
              if (node.expression.name === funcName) {
                found.push(node);
              }
              break;
            case 'TypeNameExpression':
              if (node.expression.typeName === funcName) {
                found.push(node);
              }
          }
          if (opts.findOne && found.length) {
            throw new FindOneExit(); // abort parser
          }
        },
      });
    } catch (e) {
      if (e instanceof FindOneExit) {
        return found;
      }
      throw e;
    }

    return found;
  }

  /**
   * @description get all function calls that are made inside this function (including
   * calls to imported functions but not including calls to solidity macros - see ../src/utils/macros.js)
   * @param {string[]} [omittablePaths=[]] - array of paths to omit
   * @param {{[relativePathName: string]: string}} [repoMapping=null] - mapping of relativePaths to their content within
   * the repo that this contract is defined paths, e.g. { './UniswapV3Pool.sol': 'pragma solidity ...' }
   * @returns {FunctionCall[]} - array of function call nodes
   * */
  getAllFunctionCalls(omittablePaths = [], repoMapping = null) {
    let found = [];
    parser.visit(this.ast, {
      FunctionCall(node) {
        switch (node.expression?.type) {
          case 'MemberAccess':
            if (!memberAccesses.map((ma) => ma.name).includes(node.expression?.memberName)) {
              found.push(node);
            }
            break;
          case 'Identifier':
            if (!identifiers.map((id) => id.name).includes(node.expression?.name)) {
              found.push(node);
            }
            break;
          case 'TypeNameExpression':
            if (node.expression?.typeName) {
              found.push(node);
            }
        }
      },
    });
    return this.filterNodesForOmittablePaths(found, omittablePaths, repoMapping);
  }

  /**
   * @description get all function calls that are made inside this function
   * @param {number} [depth=1] - the depth of function calls to recursively search for
   * @param {boolean} [includeImports=false] - include function calls to imported functions
   * @param {string[]} [omittableImportPaths=typicalLibraryNames] - array of paths to omit
   * @param {{[relativePathName: string]: string}} [repoMapping=null] - mapping of relativePaths to their content within
   * the repo that this contract is defined paths, e.g. { './UniswapV3Pool.sol': 'pragma solidity ...' }
   * @returns {FunctionCall[]} - array of function call nodes
   * */
  getInnerFunctionCalls(depth = 1, includeImports = false, omittableImportPaths = typicalLibraryNames, repoMapping = null) {
    let innerFunctionCalls = [];
    let functions = includeImports ? this.getAllFunctionCalls(omittableImportPaths, repoMapping) : this.contract.getFunctions();

    const findInnerCalls = (func, currentDepth) => {
      if (currentDepth > depth) {
        return;
      }

      for (let innerFunc of functions) {
        if (innerFunc.name === func.name) {
          continue;
        }
        if (includeImports) { // if we include imports we know we fetched functions as inner function calls only
          innerFunctionCalls.push(innerFunc);
          findInnerCalls(innerFunc, currentDepth + 1);
          continue;
        }
        if (func.getFunctionCalls(innerFunc.name).length > 0) {
          innerFunctionCalls.push(innerFunc);
          findInnerCalls(innerFunc, currentDepth + 1);
        }
      }
    };

    findInnerCalls(this, 1);
    return innerFunctionCalls;
  }

  _getRawFunction(func, repoMapping = null) {
    if (func.ast && func.ast.loc) {
      return {
        ast: func.ast,
        content: this.contract.sourceUnit.content,
      }
    }

    let funcName = getFunctionNameFromNode(func);
    for (let func of this.contract.getFunctions()) {
      if (func.getName() === funcName) {
        return {
          ast: func.ast,
          content: this.contract.sourceUnit.content
        }
      }
    }

    const [foundFunc, importSourceUnit] = this.findFunctionInImports(funcName, repoMapping, []) ?? [null, null];

    if (foundFunc) {
      return {
        ast: foundFunc.ast,
        content: importSourceUnit.content
      }
    }

    throw new Error(`Function ${funcName} is not defined in this SourceUnit or its imports.`);
  }

  /**
   * @param {FunctionCall} func - the function node from the ast to fetch the source code for
   * @param {{[relativePathName: string]: string}} [repoMapping=null] - mapping of relativePaths to their content within
   * the repo that this contract is defined paths, e.g. { './UniswapV3Pool.sol': 'pragma solidity ...' }
   * @returns {string} - the raw function string
   * */
  getRawFunctionString(func, repoMapping = null) {
    const {ast, content} = this._getRawFunction(func, repoMapping);
    const startLine = ast.loc.start.line;
    const endLine = ast.loc.end.line;
    const sourceLines = content.split('\n');
    const functionLines = sourceLines.slice(startLine - 1, endLine);
    return functionLines.join('\n');
  }

  getRawFunctionStartLine(func, repoMapping = null) {
    const {ast} = this._getRawFunction(func, repoMapping);
    return ast.loc.start.line;
  }

  getRawFunctionEndLine(func, repoMapping = null) {
    const {ast} = this._getRawFunction(func, repoMapping);
    return ast.loc.end.line;
  }

  getRawFunctionPragmaVersion(func, repoMapping = null) {
    const {content} = this._getRawFunction(func, repoMapping);
    const match = content.match(/pragma solidity\s*([^;]+);/);
    if (!match) {
      return '0.0.0';
    }
    const version = match[1].replace('=', '').replace(/[^\d. ]/g, '')
    const versionParts = version.split(' ');
    if (versionParts.length > 1) {
      return versionParts[1];
    }

    return versionParts[0];
  }

  /**
   * @description find a function in the imported source units
   * @param {string} funcName - the name of the function to find
   * @param {{[relativePathName: string]: string}} [repoMapping] - mapping of relativePaths to their content within
   * the repo that this contract is defined paths, e.g. { './UniswapV3Pool.sol': 'pragma solidity ...' }
   * @param {string[]} [omittablePaths=[]] - array of paths to omit
   * @returns {[FunctionDef, SourceUnit] | null} - the found function and sourceUnit or null if not found
   * */
  findFunctionInImports(funcName, repoMapping, omittablePaths = []) {
    // The function is not defined in the current SourceUnit, so look it up in the imports
    for (let importNode of this.contract.sourceUnit?.imports ?? []) {
      if (omittablePaths.some((omittablePath) => importNode.path.toLowerCase().includes(omittablePath.toLowerCase()))) {
        continue;
      }
      const importedSourceUnit = this.getSourceUnitFromImport(importNode, repoMapping);

      for (let contract of importedSourceUnit.getContracts()) {
        for (let func of contract.getFunctions()) {
          if (func.getName() === funcName) {
            return [func, importedSourceUnit];
          }
        }
      }
    }

    // Occasionally, the contract will pull in an interface named IERCO20.sol but the actual contract is ERC20.sol...
    // This is a hack to handle that case
    for (let importNode of this.contract.sourceUnit?.imports ?? []) {
      const importNodePath = importNode.path;
      if (!importNodePath) {
        continue;
      }
      const contractName = importNodePath.split('/').pop();
      if (contractName.startsWith('I')) {
        const contractNameWithoutI = contractName.slice(1);
        const contractPath = Object.keys(repoMapping).find((absPath) => absPath.toLowerCase().includes(contractNameWithoutI.toLowerCase()));
        if (!contractPath) {
          continue;
        }
        if (omittablePaths.some((omittablePath) => contractPath.toLowerCase().includes(omittablePath.toLowerCase()))) {
          continue;
        }
        const importedSourceUnit = new SourceUnit();
        importedSourceUnit.fromSource(repoMapping[contractPath]);
        for (let contract of importedSourceUnit.getContracts()) {
          for (let func of contract.getFunctions()) {
            if (func.getName() === funcName) {
              return [func, importedSourceUnit];
            }
          }
        }
      }
    }

    return null;
  }

  getSourceUnitFromImport(importNode, repoMapping) {
    let importedSourceUnit = undefined;
    try {
      let importPath = path.join(path.dirname(this.contract.sourceUnit.filePath), importNode.path);
      importedSourceUnit = new SourceUnit()
      importedSourceUnit.fromFile(importPath);
    } catch (e) {
      if (!repoMapping) {
        throw new Error(`Failed to resolve import with a sourceUnit filepath: ${this.contract.sourceUnit.filePath} and import path: ${importNode.path}. Tried
        to resolve using the repoMapping but it was not provided. Please provide the repoMapping.`);
      }
      const absolutePath = this.getAbsolutePath(importNode.path, this.contract.name, repoMapping);
      importedSourceUnit = new SourceUnit();
      importedSourceUnit.fromSource(repoMapping[absolutePath]);
    }
    if (!importedSourceUnit) {
      throw new Error(`Failed to resolve import with a sourceUnit filepath: ${this.contract.sourceUnit.filePath} and import path: ${importNode.path}.`);
    }
    return importedSourceUnit;
  }

  /**
   * @description filters out nodes in found that are defined in an omittable path
   * @param {FunctionCall[]} nodes - array of function call nodes
   * @param {string[]} omittablePaths - array of paths to omit
   * @param {{[relativePathName: string]: string}} [repoMapping=null] - mapping of relativePaths to their content within
   * the repo that this contract is defined paths, e.g. { './UniswapV3Pool.sol': 'pragma solidity ...' }
   * @returns {FunctionCall[]} - array of function call nodes
   * @private
   * */
  filterNodesForOmittablePaths(nodes, omittablePaths, repoMapping = null) {
    if (omittablePaths.length === 0) {
      return nodes;
    }
    return nodes.filter((node) => {
      const funcName = getFunctionNameFromNode(node);

      // Check if the function is defined in the current SourceUnit
      for (let func of this.contract.sourceUnit.getContracts().flatMap(contract => contract.getFunctions())) {
        if (func.getName() === funcName) {
          return true;  // Keep the node if the function is defined in the current SourceUnit
        }
      }

      // Check if the function is defined in the imports
      let functionAndSourceUnit = this.findFunctionInImports(funcName, repoMapping, omittablePaths);
      if (functionAndSourceUnit) {
        return true;  // Keep the node if the function is defined in the imports and its path is not in omittablePaths
      }

      return false;  // Exclude the node if the function is not defined in this SourceUnit or its imports
    });
  }

  getAbsolutePath(relativePath, currentContractName, repoMapping) {
    const absolutePath = path.resolve(relativePath);

    let closestAbsolutePath = null;
    let closestDistance = Infinity;

    for (const [absPath] of Object.entries(repoMapping)) {
      const distance = path.relative(absPath, absolutePath).split('/').length;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestAbsolutePath = absPath;
      }
    }

    if (!closestAbsolutePath) {
      throw new Error(`Failed to find absolute path for ${currentContractName}.sol in repoMapping.`);
    }

    return closestAbsolutePath;
  }
}

module.exports = {
  SourceUnit,
  Contract,
  FunctionDef,
};
