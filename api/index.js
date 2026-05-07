// api/index.js
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

// 允許跨網域呼叫，請將這行改成您的 GitHub Pages 網址以策安全
// 測試期間可以先用 cors() 允許所有網域
app.use(cors());
app.use(express.json());

// --- 伺服器健康檢查 API (GET) ---
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Webmail API 伺服器運作中！" });
});

// --- 寄信 API (SMTP) ---
app.post('/api/send', async (req, res) => {
const { user, pass, to, subject, text, smtpHost } = req.body;
try {
    let transporter = nodemailer.createTransport({
        host: smtpHost || 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass }
    });

    let info = await transporter.sendMail({
        from: user,
        to: to,
        subject: subject,
        text: text
    });

    res.json({ success: true, messageId: info.messageId });
} catch (error) {
    res.status(500).json({ success: false, error: error.message });
}


});
// --- 收信 API (IMAP) ---
app.post('/api/emails', async (req, res) => {
const { user, pass, imapHost } = req.body;

const config = {
    imap: {
        user: user,
        password: pass,
        host: imapHost || 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 5000 // Vercel 執行時間有限，可稍微拉長 timeout
    }
};

try {
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');
    
    // 抓取最新的 20 封信
    const searchCriteria = ['ALL'];
    const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        markSeen: false,
        results: [{ limit: 20 }] 
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    let parsedEmails = [];

    for (let item of messages) {
        const all = item.parts.find(part => part.which === '');
        const id = item.attributes.uid;
        const idHeader = "Imap-Id: "+id+"\r\n";
        const parsed = await simpleParser(idHeader + all.body);
        
        parsedEmails.push({
            id: id,
            subject: parsed.subject,
            sender: parsed.from.value[0].address,
            senderName: parsed.from.value[0].name,
            body: parsed.text,
            bodySnippet: parsed.text ? parsed.text.substring(0, 50) : '',
            timestamp: parsed.date.getTime(),
            read: item.attributes.flags.includes('\\Seen')
        });
    }

    connection.end();
    // 依照時間排序
    parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ success: true, emails: parsedEmails });

} catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
}


});
// 為了讓 Vercel 讀取，必須 Export 這個 Express 實例
module.exports = app;
