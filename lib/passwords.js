'use strict';
// Password rules. Returns '' when the password is fine, otherwise a plain-language reason.
const COMMON = new Set(('password,password1,password12,password123,password1234,passw0rd,p@ssw0rd,p@ssword,12345678,123456789,1234567890,0123456789,11111111,00000000,87654321,' +
  'qwertyui,qwerty123,qwertyuiop,qwerty12345,asdfghjk,asdfghjkl,zxcvbnm1,1q2w3e4r,1qaz2wsx,abc12345,abcd1234,abcdefgh,iloveyou,iloveyou1,welcome1,welcome123,letmein1,letmein123,' +
  'admin123,admin1234,administrator,changeme,changeme1,default1,monkey123,dragon123,football,football1,baseball,sunshine,princess,superman,master123,login123,test1234,testing123,' +
  'nigeria1,nigeria123,naija123,lagos123,lagos2020,abuja123,godisgood,godislove,jesus123,jesuschrist,blessing1,blessing123,shopbeta,shopbeta1,shop-beta,shopbeta123,ownerpass1,passw0rd1').split(','));

function check(pw, { email = '', name = '', min = 8 } = {}) {
  if (typeof pw !== 'string') return 'Please enter a password.';
  if (pw.length < min) return `Your password must be at least ${min} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || COMMON.has(low.replace(/[^a-z0-9]/g, ''))) return 'That password is too common. Please choose something harder to guess.';
  if (/^(.)\1+$/.test(pw)) return 'Please do not repeat one character.';
  if (/^(0123456789|1234567890|abcdefghij)/.test(low) || /^(\d)\1{5,}/.test(low)) return 'That password is too easy to guess.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'Your password should not contain your email name.';
  const first = String(name).toLowerCase().split(/\s+/)[0];
  if (first.length >= 4 && low === first) return 'Your password should not be your name.';
  if (new Set(pw).size < 4) return 'Please use a mix of different characters.';
  return '';
}
module.exports = { check, STAFF_MIN: 12 };
