// Auto-reply handler
module.exports = {
    // Check if message is an auto-reply trigger
    shouldReply: (text) => {
        const triggers = ['are-you-there', 'are you there', 'hello', 'hi', 'test'];
        const lowerText = text.toLowerCase().trim();
        return triggers.some(trigger => lowerText.includes(trigger));
    },
    
    // Get reply message
    getReply: () => {
        return 'Test Successful ✅\n\nBot is online and working!';
    }
};
