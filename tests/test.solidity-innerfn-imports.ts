const { SourceUnit } = require('../src/solidity.js');
const path = require('path');

// Testing subcall logic for imported contracts
let sourceUnit = new SourceUnit();
sourceUnit.fromFile(path.join(__dirname, '../tests/artifacts/baby_bank_repo/contracts/banking.sol'));
let contract = sourceUnit.getContracts().find(contract => contract.name === 'banking');

let functions = contract.getFunctions();

const withdrawfn = functions.find(func => func.name === 'withdraw');

const innerFunctions = withdrawfn.getInnerFunctionCalls(5, true);

console.log(`${withdrawfn.name} has ${innerFunctions.length} inner function calls:`);
for (let innerFunc of innerFunctions) {
  console.log(sourceUnit.getRawFunctionString(innerFunc))
}
