const fs = require('fs');
const { execSync } = require('child_process');

if (process.env.AUTH_B64) {
  fs.writeFileSync('auth.tar.gz', Buffer.from(process.env.AUTH_B64, 'base64'));
  execSync('tar -xzf auth.tar.gz');
  console.log('✅ Auth session restored from environment variable');
}

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const express = require('express');

// Store user sessions for multi-step conversations
const userSessions = new Map();

// Express server setup
const app = express();

app.get('/', (req, res) => {
  res.json({
    status: 'WhatsApp bot is alive!',
    timestamp: new Date().toISOString(),
    sessions: userSessions.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'WhatsApp bot is running',
    timestamp: new Date().toISOString(),
    activeSessions: userSessions.size
  });
});

app.get('/status', (req, res) => {
  res.json({
    botStatus: 'running',
    activeSessions: userSessions.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

const port = process.env.PORT || 5000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Express server running on port ${port}`);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting?", shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp - Imperial College Egypt Finance Bot!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    const msg = messages[0];
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    const sender = msg.key.remoteJid;
    const hasImage = msg.message?.imageMessage;
    const hasDocument = msg.message?.documentMessage;

    if (text) {
      console.log(`📩 Message from ${sender}: ${text} | FromMe: ${msg.key.fromMe}`);

      // Get or create user session
      let session = userSessions.get(sender) || { step: 'initial' };

      // If user has requested team contact, check for restart commands from bot controller
      if (session.step === 'team_contact_requested') {
        const restartKeywords = ['تم استلام المبلغ', 'payment received', 'begin', 'new', 'help'];
        const agentEndPhrase = "happy to assist. don't hesitate to reach out again if needed.";

        // Check if message is from bot controller (the bot's own number)
        const isFromBotController = msg.key.fromMe;

        // Log the received message for clarity
        console.log(`Received message for reactivation: ${text} | From bot controller: ${isFromBotController}`);

        const shouldRestart = (restartKeywords.some(keyword => 
          text.toLowerCase().includes(keyword)
        ) || text.toLowerCase() === agentEndPhrase) && isFromBotController;

        // Log the evaluated text
        console.log(`Checking for reactivation with: ${text.toLowerCase()} | Should restart: ${shouldRestart}`);

        if (shouldRestart) {
          // Reset session and continue with normal flow
          session = { step: 'initial' };
          console.log(`🔄 Bot reactivated for ${sender} - human intervention ended by controller`);

          // Send confirmation to the user that bot is reactivated
          const reactivationText = "🤖 **Assistant Reactivated**\n\nI'm back online and ready to take your request once again!";
          await sock.sendMessage(sender, { text: reactivationText });

          // Update session and continue processing
          userSessions.set(sender, session);
          return;
        } else if (!isFromBotController) {
          // Ignore messages from user when team contact is requested
          console.log(`🚫 Ignoring message from ${sender} - team contact requested`);
          return;
        } else {
          // Message from bot controller but not a restart command - ignore
          return;
        }
      }

      // Only process regular bot interactions from users (not from bot controller)
      if (msg.key.fromMe) {
        return;
      }

      // Check if message contains receipt/payment proof keywords or has attachments
      const receiptKeywords = ['receipt', 'payment', 'paid', 'proof', 'transaction', 'transfer'];
      const hasReceiptKeyword = receiptKeywords.some(keyword => 
        text.toLowerCase().includes(keyword)
      );

      if (hasImage || hasDocument || hasReceiptKeyword) {
        // Receipt submission scenario
        const responseText = "🏛️ *Imperial College Egypt - Finance Department*\n\n✅ Thank you for your payment submission.\n\n⏳ **Please wait for confirmation**\n\nOur finance team will review your payment and get back to you shortly.\n\n📞 For urgent matters, please contact the finance office directly.";
        await sock.sendMessage(sender, { text: responseText });
        console.log("✅ Sent receipt confirmation message");

        // Clear any existing session
        userSessions.delete(sender);
        return;
      }

      // Information request workflow
      switch (session.step) {
        case 'initial':
          // Welcome message and service selection
          const welcomeText = `🏛️ *Welcome to Imperial College Egypt*\n*Finance Department Assistant*\n\n📋 **How can we help you today?**\n\nPlease choose:\n\n*1* - Request information/documents\n*2* - Submit payment receipt\n*3* - Our payment plans & Deadlines\n*4* - Contact finance team\n\nType the number of your choice.`;
          await sock.sendMessage(sender, { text: welcomeText });
          session.step = 'service_selection';
          break;

        case 'service_selection':
          if (text === '1') {
            session.step = 'collect_info_student_count';
            const infoStudentCountPrompt = "📝 **Information Request**\n\nHow many students do you need information for?\n\nPlease type the number (e.g., 1, 2, 3...)";
            await sock.sendMessage(sender, { text: infoStudentCountPrompt });
          } else if (text === '2') {
            const receiptInstructions = "📎 **Payment Receipt Submission**\n\nPlease send your payment receipt/proof as:\n• Photo\n• Document\n• Or type details in your message\n\nWe'll confirm receipt shortly.\n\n⏳ **Please wait for someone from our team to contact you.**\n\n🤖 *Assistant service ended. It will be restarted after reviewing you request.*";
            await sock.sendMessage(sender, { text: receiptInstructions });
            // Mark this user as needing team contact - bot will ignore future messages
            session.step = 'team_contact_requested';
            userSessions.set(sender, session);
            return;
          } else if (text === '3') {
            const paymentPlansInfo = "💰 **Payment Plans & Deadlines**\n\n📅 **Academic Year Payment Schedule:**\n\n🔸 **1st Installment 40%** - July\nBeginning from 01-06-20XX To 15-06-20XX\n\n🔸 **2nd Installment 30%** - September\nBeginning from 01-09-20XX To 15-09-20XX\n\n🔸 **3rd Installment 30%** - December\nBeginning from 01-12-20XX To 15-12-20XX\n\n📞 For specific dates and detailed information, please contact our finance team.\n\n🏛️ *Imperial College Egypt - Finance Department*";
            await sock.sendMessage(sender, { text: paymentPlansInfo });
            // Reset session after providing information
            userSessions.delete(sender);
            return;
          } else if (text === '4') {
            session.step = 'select_contact_type';
            const contactTypePrompt = "💬 **Contact Finance Team**\n\nPlease specify your relation:\n\n*1* - Parent\n*2* - Supplier (مورد)\n\nType the number of your choice.";
            await sock.sendMessage(sender, { text: contactTypePrompt });
          } else {
            const invalidChoice = "❌ Invalid choice. Please type:\n*1* For information request\n*2* For payment receipt\n*3* For payment plans & deadlines\n*4* To contact finance team";
            await sock.sendMessage(sender, { text: invalidChoice });
          }
          break;

        case 'collect_info_student_count':
          const infoStudentCount = parseInt(text);
          if (isNaN(infoStudentCount) || infoStudentCount < 1 || infoStudentCount > 10) {
            const invalidInfoCount = "❌ Please enter a valid number between 1 and 10.";
            await sock.sendMessage(sender, { text: invalidInfoCount });
            break;
          }

          session.infoStudentCount = infoStudentCount;
          session.infoStudents = [];
          session.currentInfoStudentIndex = 0;
          session.step = 'collect_name';

          const firstInfoStudentPrompt = `📝 **Student ${session.currentInfoStudentIndex + 1} of ${session.infoStudentCount}**\n\n👤 **Student Full Name:**`;
          await sock.sendMessage(sender, { text: firstInfoStudentPrompt });
          break;

        case 'collect_name':
          if (!session.infoStudents) session.infoStudents = [];
          if (!session.infoStudents[session.currentInfoStudentIndex]) {
            session.infoStudents[session.currentInfoStudentIndex] = {};
          }

          session.infoStudents[session.currentInfoStudentIndex].name = text;
          session.step = 'collect_year';
          const yearPrompt = `📅 **Student ${session.currentInfoStudentIndex + 1} Academic Year/Section:**\n\nExample: Y1 British, G1 American, etc.`;
          await sock.sendMessage(sender, { text: yearPrompt });
          break;

        case 'collect_year':
          session.infoStudents[session.currentInfoStudentIndex].year = text;
          session.step = 'collect_id';
          const idPrompt = `🆔 **Student ${session.currentInfoStudentIndex + 1} ID Number:**`;
          await sock.sendMessage(sender, { text: idPrompt });
          break;

        case 'collect_id':
          session.infoStudents[session.currentInfoStudentIndex].id = text;
          session.currentInfoStudentIndex++;

          // Check if we need to collect more students
          if (session.currentInfoStudentIndex < session.infoStudentCount) {
            session.step = 'collect_name';
            const nextInfoStudentPrompt = `📝 **Student ${session.currentInfoStudentIndex + 1} of ${session.infoStudentCount}**\n\n👤 **Student Full Name:**`;
            await sock.sendMessage(sender, { text: nextInfoStudentPrompt });
            break;
          }

          // All students collected, ask for requirement
          session.step = 'collect_requirement';
          const requirementPrompt = "📋 **What do you need from us?**\n\nPlease choose:\n\n*1* - Payment Order\n*2* - Payment Link\n*3* - Other (Someone from our team will be with you as soons as possible)\n\nType the number of your choice.";
          await sock.sendMessage(sender, { text: requirementPrompt });
          break;

        case 'select_contact_type':
          if (text === '1') {
            // Parent flow - ask about number of students first
            session.contactType = 'Parent';
            session.step = 'collect_student_count';
            const studentCountPrompt = "📝 **Parent Request**\n\nHow many students do you have at Imperial College Egypt?\n\nPlease type the number (e.g., 1, 2, 3...)";
            await sock.sendMessage(sender, { text: studentCountPrompt });
          } else if (text === '2') {
            // Supplier flow - direct contact
            session.contactType = 'Supplier';
            const supplierContactInfo = "💬 **Contact Finance Team**\n\n🏢 **Office Location:** Finance Department\n⏰ **Working Hours:** Sunday-Thursday, 9 AM - 2 PM\n📧 **Email:** finance@imperialcollegeegypt.edu.eg\n📱 **Phone:** +20 10 5023 9220\n\n⏳ **Please wait for someone from our team to contact you.**\n\n🤖 *Assistant service ended. It will be restarted after reviewing you request.*";
            await sock.sendMessage(sender, { text: supplierContactInfo });
            // Mark this user as needing team contact - bot will ignore future messages
            session.step = 'team_contact_requested';
            userSessions.set(sender, session);
            return;
          } else {
            const invalidContactType = "❌ Invalid choice. Please type:\n*1* For Parent\n*2* For Supplier (مورد)";
            await sock.sendMessage(sender, { text: invalidContactType });
          }
          break;

        case 'collect_student_count':
          const studentCount = parseInt(text);
          if (isNaN(studentCount) || studentCount < 1 || studentCount > 10) {
            const invalidCount = "❌ Please enter a valid number between 1 and 10.";
            await sock.sendMessage(sender, { text: invalidCount });
            break;
          }

          session.studentCount = studentCount;
          session.students = [];
          session.currentStudentIndex = 0;
          session.step = 'collect_parent_student_name';

          const firstStudentPrompt = `📝 **Student ${session.currentStudentIndex + 1} of ${session.studentCount}**\n\n👤 **Student Full Name:**`;
          await sock.sendMessage(sender, { text: firstStudentPrompt });
          break;

        case 'collect_parent_student_name':
          if (!session.students) session.students = [];
          if (!session.students[session.currentStudentIndex]) {
            session.students[session.currentStudentIndex] = {};
          }

          session.students[session.currentStudentIndex].name = text;
          session.step = 'collect_parent_student_year';
          const parentYearPrompt = `📅 **Student ${session.currentStudentIndex + 1} Academic Year/Section:**\n\nExample: Y1 British, G1 American, etc.`;
          await sock.sendMessage(sender, { text: parentYearPrompt });
          break;

        case 'collect_parent_student_year':
          session.students[session.currentStudentIndex].year = text;
          session.step = 'collect_parent_student_id';
          const parentIdPrompt = `🆔 **Student ${session.currentStudentIndex + 1} ID Number:**`;
          await sock.sendMessage(sender, { text: parentIdPrompt });
          break;

        case 'collect_parent_student_id':
          session.students[session.currentStudentIndex].id = text;
          session.currentStudentIndex++;

          // Check if we need to collect more students
          if (session.currentStudentIndex < session.studentCount) {
            session.step = 'collect_parent_student_name';
            const nextStudentPrompt = `📝 **Student ${session.currentStudentIndex + 1} of ${session.studentCount}**\n\n👤 **Student Full Name:**`;
            await sock.sendMessage(sender, { text: nextStudentPrompt });
            break;
          }

          // All students collected, send contact info and summary
          const parentContactInfo = "💬 **Finance Department**\n\n⏰ **(Summer)Working Hours:** Sunday-Thursday, 9 AM - 2 PM\n📧 **Email:** finance@imperialcollegeegypt.edu.eg\n📱 **Phone:** +20 10 5023 9220";
          await sock.sendMessage(sender, { text: parentContactInfo });

          // Create summary for all students
          let studentsDetails = "📋 **Student Details**\n\n";
          session.students.forEach((student, index) => {
            studentsDetails += `**Student ${index + 1}:**\n👤 **Name:** ${student.name}\n📅 **Year:** ${student.year}\n🆔 **ID:** ${student.id}\n\n`;
          });
          studentsDetails += "⏳ **Someone from our finance team will get back to you shortly.**\n\n🤖 *Assistant service ended. It will be restarted after reviewing you request.*\n\n🏛️ *Imperial College Egypt - Finance Department*";

          await sock.sendMessage(sender, { text: studentsDetails });

          console.log(`✅ Completed parent contact request for ${session.studentCount} students - Bot stopped`);

          // Mark user as needing team contact
          session.step = 'team_contact_requested';
          userSessions.set(sender, session);
          return;

        case 'collect_requirement':
          let requirement = '';
          if (text === '1') {
            requirement = 'Payment Order';
          } else if (text === '2') {
            requirement = 'Payment Link';
          } else if (text === '3') {
            requirement = 'Other - Team Contact Needed';

            // Create summary for all students
            let infoStudentsDetails = "📋 **Request Summary**\n\n";
            session.infoStudents.forEach((student, index) => {
              infoStudentsDetails += `**Student ${index + 1}:**\n👤 **Name:** ${student.name}\n📅 **Year:** ${student.year}\n🆔 **ID:** ${student.id}\n\n`;
            });
            infoStudentsDetails += `📋 **Request:** ${requirement}\n\n⏳ **Someone from our finance team will get back to you shortly.**\n\n🤖 *Assistant service ended. It will be restarted after reviewing you request.*\n\n🏛️ *Imperial College Egypt - Finance Department*`;

            await sock.sendMessage(sender, { text: infoStudentsDetails });
            console.log(`✅ Completed request for ${session.infoStudentCount} students: ${requirement} - Bot stopped`);

            // Mark user as needing team contact
            session.step = 'team_contact_requested';
            userSessions.set(sender, session);
            return;
          } else {
            const invalidReq = "❌ Invalid choice. Please type:\n*1* For Payment Order\n*2* For Payment Link\n*3* For Other(Team Contact)";
            await sock.sendMessage(sender, { text: invalidReq });
            break;
          }

          // Create summary for all students and complete request
          let infoStudentsDetails = "📋 **Request Summary**\n\n";
          session.infoStudents.forEach((student, index) => {
            infoStudentsDetails += `**Student ${index + 1}:**\n👤 **Name:** ${student.name}\n📅 **Year:** ${student.year}\n🆔 **ID:** ${student.id}\n\n`;
          });
          infoStudentsDetails += `📋 **Request:** ${requirement}\n\n✅ **Your request has been recorded.**\n\n⏳ **Please wait while we process your request.**\n\n⏳ **Someone from our finance team will get back to you shortly.**\n\n🤖 *Assistant service ended. It will be restarted after reviewing you request.*\n\n🏛️ *Imperial College Egypt - Finance Department*`;

          await sock.sendMessage(sender, { text: infoStudentsDetails });
          console.log(`✅ Completed request for ${session.infoStudentCount} students: ${requirement} - Bot stopped for human intervention`);

          // Mark user as needing team contact
          session.step = 'team_contact_requested';
          userSessions.set(sender, session);
          return;

        default:
          // Reset to initial if something goes wrong
          session.step = 'initial';
          const resetText = "🏛️ *Imperial College Egypt - Finance Department*\n\nLet's start over. How can we help you today?\n\n*1* - Request information\n*2* - Submit payment receipt\n*3* - Payment plans & deadlines\n*4* - Contact finance team";
          await sock.sendMessage(sender, { text: resetText });
      }

      // Save session
      userSessions.set(sender, session);
    }
  });
}

startBot();
