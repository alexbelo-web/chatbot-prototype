require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function loadDocuments() {
  const docsPath = path.join(__dirname, 'docs');
  const files = fs.readdirSync(docsPath);
  const documents = [];

  console.log(`Loading ${files.length} documents...`);

  for (const file of files) {
    const filePath = path.join(docsPath, file);
    const ext = path.extname(file).toLowerCase();
    let content = '';

    try {
      if (ext === '.txt') {
        content = fs.readFileSync(filePath, 'utf8');
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
      } else if (ext === '.pdf') {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);
        content = data.text;
      } else if (ext === '.xlsx') {
        const workbook = XLSX.readFile(filePath);
        for (const sheet of workbook.SheetNames) {
          content += XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
        }
      }

      if (content.trim()) {
        documents.push({ name: file, content: content.trim() });
      }
    } catch (err) {
      console.log(`Could not read ${file}: ${err.message}`);
    }
  }

  console.log(`Loaded ${documents.length} documents successfully.`);
  return documents;
}

function getRelevantDocs(query, documents, topN = 5) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  const scored = documents.map(doc => {
    const text = (doc.name + ' ' + doc.content).toLowerCase();
    const score = queryWords.reduce((acc, word) => {
      const count = (text.match(new RegExp(word, 'g')) || []).length;
      return acc + count;
    }, 0);
    return { ...doc, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .filter(d => d.score > 0);
}

let allDocuments = [];

const systemPrompt = `You are the Legato Knowledge Assistant, an internal AI tool built for consultants at Legato Strategic Consulting. Legato specializes in Workday Student implementations.

Your job is to answer questions using the internal Legato documents provided to you. These include step-by-step Workday guides, process documentation, meeting transcripts, and Legato-specific knowledge.

Rules:
- Always prioritize answers from the provided documents
- When your answer comes from a document, mention the document name as your source
- If the documents do not cover the question, you may use your general Workday knowledge but clearly say "This is based on general Workday knowledge, not a Legato document"
- Be clear, concise, and helpful
- Format responses with structure and line breaks where it helps readability
- This tool is for internal use only

RELEVANT DOCUMENTS FOR THIS QUESTION:
{{DOCUMENTS}}`;

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;

  try {
    const relevantDocs = getRelevantDocs(message, allDocuments);
    const docContext = relevantDocs.length > 0
      ? relevantDocs.map(d => `--- SOURCE: ${d.name} ---\n${d.content.slice(0, 3000)}`).join('\n\n')
      : 'No specific documents found for this query. Use general Workday knowledge.';

    const fullPrompt = systemPrompt.replace('{{DOCUMENTS}}', docContext);

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: fullPrompt
    });

    const chat = model.startChat({
      history: history || []
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    res.json({ reply: response.text() });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

loadDocuments().then(docs => {
  allDocuments = docs;
  app.listen(3000, () => {
    console.log('Legato Knowledge Assistant running on http://localhost:3000');
  });
});