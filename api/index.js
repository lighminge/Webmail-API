const express = require('express');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

// CORS 攔截器設定 (手動處理跨域，不依賴 cors 套件以避免 Vercel 阻擋)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.use(express.json());

// --- 健康檢查 ---
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Webmail API 伺服器運作中！支援 HTML 格式處理與真實刪除。" });
});

// --- 寄信 API (SMTP) ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost } = req.body;
    
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
            text: text,
            // 【新增】支援發送 HTML 格式 (若無提供則將純文字換行轉為 <br>)
            html: html || text.replace(/\n/g, '<br>') 
        });

        res.json({ success: true, messageId: info.messageId });
    } catch (error) {
        console.error("SMTP Error:", error);
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
            user: user, password: pass,
            host: imapHost || 'imap.gmail.com',
            port: 993, tls: true, authTimeout: 8000
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

// --- 收信 API (IMAP) ---
app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost } = req.body;

    const config = {
        imap: {
            user: user, password: pass,
            host: imapHost || 'imap.gmail.com',
            port: 993, tls: true, authTimeout: 8000
        }
    };

    try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');
        
        const searchCriteria = ['ALL'];
        const fetchOptions = {
            bodies: ['HEADER', 'TEXT', ''],
            markSeen: false,
            results: [{ limit: 15 }] // 抓取最新的 15 封信
        };

        const messages = await connection.search(searchCriteria, fetchOptions);
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const idHeader = "Imap-Id: "+id+"\r\n";
            const parsed = await simpleParser(idHeader + all.body);
            
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';
            const senderName = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].name : senderEmail;

            parsedEmails.push({
                id: id,
                subject: parsed.subject || '(無主旨)',
                sender: senderEmail,
                senderName: senderName,
                body: parsed.text || '',
                // 【重點新增】抓取並回傳原始的 HTML 結構 (圖片與超連結)
                html: parsed.html || parsed.textAsHtml || '', 
                bodySnippet: parsed.text ? parsed.text.substring(0, 50).replace(/\n/g, ' ') : '',
                timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                read: item.attributes.flags.includes('\\Seen')
            });
        }

        connection.end();
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails });

    } catch (error) {
        console.error("IMAP Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
