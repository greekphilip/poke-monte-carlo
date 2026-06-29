const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// Add selection controls definition
const updateFunc = `
function updatePortfolioSelectionControls() {
  const count = state.portfolioSelectedIds.size;
  if (el("portfolioSelectedCount")) el("portfolioSelectedCount").textContent = \`\${count.toLocaleString()} selected\`;
  if (el("applyBulkStatusBtn")) el("applyBulkStatusBtn").disabled = count === 0;
}
`;
code = code.replace(/function updatePortfolioCard\(row, input\) \{/, updateFunc + '\nfunction updatePortfolioCard(row, input) {');

// Attach to selection events
code = code.replace(/        state\.portfolioSelectedIds\.add\(row\.dataset\.portfolioCardId\);\n/g, '        state.portfolioSelectedIds.add(row.dataset.portfolioCardId);\n        updatePortfolioSelectionControls();\n');
code = code.replace(/        state\.portfolioSelectedIds\.delete\(row\.dataset\.portfolioCardId\);\n/g, '        state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);\n        updatePortfolioSelectionControls();\n');
code = code.replace(/      state\.portfolioSelectedIds\.delete\(row\.dataset\.portfolioCardId\);\n/g, '      state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);\n      updatePortfolioSelectionControls();\n');
code = code.replace(/    \);\n    renderPortfolio\(\);\n  \}\);\n  el\("clearPortfolioSelectionBtn"\)/g, '    );\n    updatePortfolioSelectionControls();\n    renderPortfolio();\n  });\n  el("clearPortfolioSelectionBtn")');
code = code.replace(/  el\("clearPortfolioSelectionBtn"\)\.addEventListener\("click", \(\) => \{\n    state\.portfolioSelectedIds\.clear\(\);\n    renderPortfolio\(\);\n  \}\);/g, '  el("clearPortfolioSelectionBtn").addEventListener("click", () => {\n    state.portfolioSelectedIds.clear();\n    updatePortfolioSelectionControls();\n    renderPortfolio();\n  });');

// Remove batchId logic from updatePortfolioCard
code = code.replace(/    record\[field\] = input\.value \|\| \(field === "batchId" \? null : "inventory"\);\n  \}\n  if \(field === "batchId" && record\.batchId\) \{\n    const batch = state\.portfolio\.batches\.find\(\(item\) => item\.id === record\.batchId\);\n    if \(record\.status === "inventory" || record\.status === "planned"\) \{\n      record\.status = batch\?\.status === "draft" \? "planned" : "submitted";\n    \}\n  \}/, '    record[field] = input.value || "inventory";\n  }');

fs.writeFileSync('app.js', code);
