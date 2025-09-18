import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();
import { v4 as uuidv4 } from 'uuid';

import {
  parseIntent,
  getVariables,
  submitCatalog,
  pollRitm,
  getLoggedInUser,
} from './services/servicenow.js';

import {
  initSession,
  getSession,
  updateAnswer,
  isComplete,
  getNextQuestion,
  getAnswers,
  clearSession,
  tryHandleCorrection,
} from './utils/stateManager.js';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(bodyParser.json());

const ritmSubscribers = new Map();

app.post(['/webhook', '/'], async (req, res) => {
  try {
    const headers = req.headers;
    const body = req.body || {};
    const signature = headers['x-elevenlabs-signature'];

    if (signature && signature !== process.env.WEBHOOK_SECRET) {
      console.warn('Invalid webhook secret');
      return res.status(401).send('Unauthorized');
    }

    let sessionId = body.session_id || body.conversation_id || uuidv4();
    let userMessage = (body.message || body.text || '').toString().trim();

    if (body.type === 'post_call_transcription' && Array.isArray(body.data?.transcript)) {
      userMessage = body.data.transcript.at(-1)?.text?.trim() || userMessage;
      sessionId = body.data?.conversation_id || sessionId;
    }

    console.log(`Incoming webhook - sessionId=${sessionId} message="${userMessage}"`);

    if (!sessionId || !userMessage) {
      return res.status(400).json({ reply: 'Invalid request format.' });
    }

    let session = getSession(sessionId);

    // New session: parse intent
    if (!session) {
      const intentResult = await parseIntent(userMessage);
      if (!intentResult) return res.status(404).json({ reply: "Sorry, I couldn't understand the request." });

      const catalogSysId = intentResult.catalog_item_sys_id;
      if (!catalogSysId) return res.status(404).json({ reply: "No catalog matched." });

      // Get variables
      const variablesData = await getVariables(catalogSysId);
      let variables = Array.isArray(variablesData?.variables) ? variablesData.variables : [];

      // Prefill requested_for from logged-in user
      try {
        const userData = intentResult.user || await getLoggedInUser();
        if (userData?.sys_id) {
          variables = variables.filter(v => v.name !== 'requested_for');
          variables.unshift({
            name: 'requested_for',
            question: 'Requested for',
            type: 'string',
            answer: userData.sys_id,
            displayName: userData.name
          });
        }
      } catch (e) {
        console.warn('Failed to fetch logged-in user:', e);
      }

      initSession(sessionId, catalogSysId, variables);

      // Skip prefilled variables
      session = getSession(sessionId);
      while (session.askedIndex < session.variables.length && session.variables[session.askedIndex]?.answer != null) {
        session.askedIndex++;
      }

      session.state = 'awaiting_variable';
      const firstQ = getNextQuestion(sessionId);
      if (!firstQ) {
        const collected = getAnswers(sessionId);
        session.state = 'confirming';
        const confirmMsg = Object.entries(collected)
          .filter(([k]) => k !== 'requested_for')
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join(', ');
        return res.json({ reply: `Just to confirm, you said: ${confirmMsg}. Should I submit this request?` });
      }

      console.log(`Asking first variable: ${session.variables[session.askedIndex]?.name}`);
      return res.json({ reply: `Sure, to help with that, ${firstQ}` });
    }

    // Awaiting variable answers
    if (session.state === 'awaiting_variable') {
      const currentField = session.variables[session.askedIndex];
      console.log(`Answer received for "${currentField?.name}": "${userMessage}"`);
      updateAnswer(sessionId, userMessage);

      // Log cleaned value after updateAnswer
      const cleanedAnswer = session.variables[session.askedIndex - 1]?.answer;
      console.log(`Stored answer for "${currentField?.name}": "${cleanedAnswer}"`);

      if (!isComplete(sessionId)) {
        const nextQ = getNextQuestion(sessionId);
        return res.json({ reply: nextQ || "Got it. What’s next?" });
      }

      session.state = 'confirming';
      const collected = getAnswers(sessionId);
      const confirmMsg = Object.entries(collected)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
        .join(', ');

      console.log('Collected all answers:', collected);
      return res.json({ reply: `Just to confirm, you said: ${confirmMsg}. Should I submit this request?` });
    }

    //Confirming submission
    if (session.state === 'confirming') {
      const affirm = /\b(yes|ok|sure|yep|yeah|affirmative|please do)\b/i.test(userMessage);

      if (affirm) {
        try {
          const catalogId = session.catalogId;
          const variables = session.variables.reduce((acc, v) => {
            acc[v.name] = v.answer;
            return acc;
          }, {});

          const result = await submitCatalog(catalogId, variables);
          console.log('Submission result:', result);

          const ritmNumber = result.ritm_number || result.request_id || result.requestId;
          if (ritmNumber) {
            ritmSubscribers.set(ritmNumber, { sessionId, resolved: false });

            // Poll until closed/complete
            await pollRitm(ritmNumber, (info) => {
              console.log('RITM complete callback:', info);
            }).catch((e) => console.warn('Poll error', e));
          }

          // Get RITM state and description
          const ritmData = await pollRitm(ritmNumber, () => {}, 1000, 1) || {};
          const description = ritmData.description || '';

          clearSession(sessionId);

          return res.json({
            reply: `Request submitted successfully! RITM Number: ${ritmNumber}. Ticket is closed, the booked space is: ${description}. Do you want directions?`,
          });
        } catch (err) {
          console.error('Submission failed:', err.response?.data || err.message || err);
          clearSession(sessionId);
          return res.json({ reply: "I'm sorry, something went wrong while submitting. Please try again later." });
        }
      }

      // Handle corrections
      const corrected = tryHandleCorrection(sessionId, userMessage);
      if (corrected) {
        const newConfirm = Object.entries(getAnswers(sessionId))
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join(', ');
        return res.json({ reply: `Got it — updated. Just to confirm, you said: ${newConfirm}. Should I submit this request?` });
      }

      clearSession(sessionId);
      return res.json({ reply: "Okay, request canceled. Let me know if you need anything else." });
    }

    return res.json({ reply: "I'm not sure what you meant. Could you repeat that?" });

  } catch (err) {
    console.error('Webhook error occurred:', err.message || err);
    return res.status(500).json({ reply: 'Server error: ' + (err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Voice webhook running at ${process.env.PUBLIC_URL || `http://localhost:${PORT}`}`);
});