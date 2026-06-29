const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Remove all batch-related functions by replacing them with empty bodies
code = code.replace(/function createPortfolioBatch\(name, cardIds = \[\]\) \{[\s\S]*?\n\}/, `function createPortfolioBatch(name, cardIds = []) {}`);
code = code.replace(/function saveOptimizerSelectionAsBatch\(\) \{[\s\S]*?\n\}/, `function saveOptimizerSelectionAsBatch() {}`);
code = code.replace(/function batchCardIds\(batchId\) \{[\s\S]*?\n\}/, `function batchCardIds(batchId) {}`);
code = code.replace(/function renderPortfolioBatches\(ranking\) \{[\s\S]*?\n\}/, `function renderPortfolioBatches(ranking) {}`);
code = code.replace(/function renderPortfolioStrategy\(ranking\) \{[\s\S]*?\n\}/, `function renderPortfolioStrategy(ranking) {}`);
code = code.replace(/function markActiveBatchSubmitted\(\) \{[\s\S]*?\n\}/, `function markActiveBatchSubmitted() {}`);
code = code.replace(/function deleteDraftBatch\(\) \{[\s\S]*?\n\}/, `function deleteDraftBatch() {}`);
code = code.replace(/function addSelectedToBatch\(\) \{[\s\S]*?\n\}/, `function addSelectedToBatch() {}`);

// 2. Remove renderPortfolioBatches, renderPortfolioStrategy calls in renderPortfolio
code = code.replace(/  renderPortfolioBatches\(ranking\);\n  renderPortfolioStrategy\(ranking\);\n/g, '');

// 3. Remove batch table cell from renderPortfolio mapping
code = code.replace(/      <td><select data-portfolio-field="batchId">[\s\S]*?<\/select><\/td>\n/g, '');

// 4. Remove the portfolioActiveBatchId from state
code = code.replace(/  portfolioActiveBatchId: "",\n/g, '');

// 5. Remove event listeners safely. Since event listener blocks can contain arbitrary code, let's just grep the specific listener lines.
code = code.replace(/  el\("saveOptimizerBatchBtn"\)\.addEventListener\("click", saveOptimizerSelectionAsBatch\);\n/g, '');
code = code.replace(/  el\("markBatchSubmittedBtn"\)\.addEventListener\("click", markActiveBatchSubmitted\);\n/g, '');
code = code.replace(/  el\("deleteDraftBatchBtn"\)\.addEventListener\("click", deleteDraftBatch\);\n/g, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)\.addEventListener\("click", addSelectedToBatch\);\n/g, '');

fs.writeFileSync('app.js', code);
