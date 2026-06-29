const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

const updateFunc = `
function updatePortfolioSelectionControls() {
  const count = state.portfolioSelectedIds.size;
  if (el("portfolioSelectedCount")) el("portfolioSelectedCount").textContent = \`\${count.toLocaleString()} selected\`;
  if (el("applyBulkStatusBtn")) el("applyBulkStatusBtn").disabled = count === 0;
}
`;

code = code.replace(/function updatePortfolioCard\(row, input\) \{/, updateFunc + '\nfunction updatePortfolioCard(row, input) {');

// Now we need to call updatePortfolioSelectionControls() whenever state.portfolioSelectedIds changes.
// Check if the script has it in line 3523, 3525, 3540, 3546
code = code.replace(/        state\.portfolioSelectedIds\.add\(row\.dataset\.portfolioCardId\);\n/g, '        state.portfolioSelectedIds.add(row.dataset.portfolioCardId);\n        updatePortfolioSelectionControls();\n');
code = code.replace(/        state\.portfolioSelectedIds\.delete\(row\.dataset\.portfolioCardId\);\n/g, '        state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);\n        updatePortfolioSelectionControls();\n');
code = code.replace(/      state\.portfolioSelectedIds\.delete\(row\.dataset\.portfolioCardId\);\n/g, '      state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);\n      updatePortfolioSelectionControls();\n');
code = code.replace(/    \);\n    renderPortfolio\(\);\n  \}\);\n  el\("clearPortfolioSelectionBtn"\)/g, '    );\n    updatePortfolioSelectionControls();\n    renderPortfolio();\n  });\n  el("clearPortfolioSelectionBtn")');

fs.writeFileSync('app.js', code);
