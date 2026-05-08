const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

// 完整的 CORS 設定
app.use(cors({
    origin: '*', // 允許所有網域
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 【關鍵修復】因應 Express 最新版更新，不再使用 '*' 萬用字元
// 改為直接指定我們要開放 CORS 預檢的兩支 API 路徑
app.options('/api/emails', cors());
app.options('/api/send', cors());

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
        console.error("SMTP Error:", error);
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
            authTimeout: 8000 // 延長超時時間
        }
    };

    try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');
        
        // 抓取最新的 15 封信
        const searchCriteria = ['ALL'];
        const fetchOptions = {
            bodies: ['HEADER', 'TEXT', ''],
            markSeen: false,
            results: [{ limit: 15 }] 
        };

        const messages = await connection.search(searchCriteria, fetchOptions);
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const idHeader = "Imap-Id: "+id+"\r\n";
            const parsed = await simpleParser(idHeader + all.body);
            
            // 加入安全防護，避免寄件者名稱為空時引發錯誤
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';
            const senderName = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].name : senderEmail;

            parsedEmails.push({
                id: id,
                subject: parsed.subject || '(無主旨)',
                sender: senderEmail,
                senderName: senderName,
                body: parsed.text || '',
                bodySnippet: parsed.text ? parsed.text.substring(0, 50).replace(/\n/g, ' ') : '',
                timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                read: item.attributes.flags.includes('\\Seen')
            });
        }

        connection.end();
        // 依照時間排序
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails });

    } catch (error) {
        console.error("IMAP Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 刪除信件 API (IMAP 同步真實刪除) ---
app.post('/api/delete', async (req, res) => {
    const { user, pass, imapHost, uids } = req.body;
    
    if (!uids || !Array.isArray(uids) || uids.length === 0) {
        return res.status(400).json({ success: false, error: "未提供信件 UID" });
    }

    const config = {
        imap: {
            user: user,
            password: pass,
            host: imapHost || 'imap.gmail.com',
            port: 993,
            tls: true,
            authTimeout: 8000
        }
    };

    try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');
        
        // 將指定的 UIDs 加上 \Deleted 標籤
        await connection.addFlags(uids, '\\Deleted');
        
        // 執行 EXPUNGE 指令來真正清空被標記為刪除的信件
        await connection.imap.expunge((err) => {
            if (err) throw err;
        });
        
        connection.end();
        res.json({ success: true, message: `已刪除 ${uids.length} 封信件` });

    } catch (error) {
        console.error("IMAP Delete Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
