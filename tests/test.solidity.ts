const { SourceUnit } = require('../src/solidity.js');
const path = require('path');

// Fetching test file
let sourceUnit = new SourceUnit();
sourceUnit.fromFile(path.join(__dirname, '../tests/artifacts/baby_bank_repo/contracts/baby_bank.sol'));

// Fetching baby_bank contract
let contract = sourceUnit.getContracts().find(contract => contract.name === 'baby_bank');

// Testing subcall logic
let functions = contract.getFunctions();
for (let func of functions) {
  const innerFunctions = func.getInnerFunctionCalls();
  console.log(`${func.name} has ${innerFunctions.length} inner function calls:`);
  for (let innerFunc of innerFunctions) {
    console.log(`\t${innerFunc.name}`);
  }
}