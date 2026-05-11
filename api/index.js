const express = require('express');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());

app.get('/', (req, res) => res.json({ status: "OK", message: "Webmail API 伺服器運作中！" }));

// --- reCAPTCHA v3 後端真實驗證 API ---
app.post('/api/verify-recaptcha', async (req, res) => {
    const { token, action } = req.body;
    
    // 您的專屬 Google reCAPTCHA v3 秘鑰
    const secretKey = '6LfZK-QsAAAAAMHUdBQggSvq2QkM7bqhHzbwcPT-';

    if (!token) {
        return res.status(400).json({ success: false, error: "未提供驗證 Token" });
    }

    try {
        // 向 Google 驗證伺服器發送確認請求
        const response = await fetch(`https://www.google.com/recaptcha/api/siteverify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${secretKey}&response=${token}`
        });

        const data = await response.json();
        
        // 驗證成功且分數 >= 0.5 (代表為人類行為)，且動作名稱一致
        if (data.success && data.score >= 0.5 && data.action === action) {
            res.json({ success: true, score: data.score });
        } else {
            console.warn("reCAPTCHA 未通過:", data);
            res.json({ success: false, error: "判定為機器人或驗證失敗", details: data });
        }
    } catch (error) {
        console.error("reCAPTCHA 伺服器通訊錯誤:", error);
        res.status(500).json({ success: false, error: "伺服器驗證通訊異常" });
    }
});

// --- 寄信 API ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost } = req.body;
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost || 'smtp.gmail.com', port: 465, secure: true,
            auth: { user, pass }
        });
        let info = await transporter.sendMail({
            from: user, to, subject, text, html: html || text.replace(/\n/g, '<br>') 
        });
        res.json({ success: true, messageId: info.messageId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 刪除信件 API ---
app.post('/api/delete', async (req, res) => {
    const { user, pass, imapHost, uids } = req.body;
    if (!uids || !uids.length) return res.status(400).json({ success: false });
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uids, '\\Deleted');
        await connection.imap.expunge((err) => { if (err) throw err; });
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 標記已讀 API ---
app.post('/api/mark-read', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Seen');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 標記已回覆 API ---
app.post('/api/mark-answered', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Answered');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 收信 API ---
app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        const messages = await connection.search(['ALL'], { bodies: ['HEADER', 'TEXT', ''], markSeen: false, results: [{ limit: 15 }] });
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const parsed = await simpleParser("Imap-Id: "+id+"\r\n" + all.body);
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';
            
            parsedEmails.push({
                id: id,
                subject: parsed.subject || '(無主旨)',
                sender: senderEmail,
                senderName: parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].name : senderEmail,
                body: parsed.text || '',
                html: parsed.html || parsed.textAsHtml || '', 
                bodySnippet: parsed.text ? parsed.text.substring(0, 50).replace(/\n/g, ' ') : '',
                timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                read: item.attributes.flags.includes('\\Seen'),
                replied: item.attributes.flags.includes('\\Answered') // 取得是否已回信的標籤
            });
        }
        connection.end();
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

module.exports = app;
