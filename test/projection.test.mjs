import test from 'node:test';
import assert from 'node:assert/strict';
import { compileProject, compileSelection } from '../dist/compiler.js';

test('selected code keeps only used helpers and stays stable across unrelated ID/formatter changes', async () => {
  for (const development of [false, true]) {
    const en = {
      a: '{n, number}',
      date: '{when, date, short}',
      text: '"$f0" \\ $f1Cache $literal \'</script>\'\u2028 {name}',
      money: '{n, number, ::currency/USD}',
      plural: '{n, plural, one {# thing} other {# things}}',
      then: 'Then', default: 'Default',
      ['__proto__']: 'Prototype {name}', constructor: 'Constructor {name}',
    };
    const options = {baseLocale:'en',development,catalogs:{en,fr:{...en,money:'FR {n, number, ::currency/EUR}'}}};
    const before = compileProject(options);
    const keys = ['text','money','plural','then','default','money','__proto__','constructor'];
    const source = compileSelection(before,'index.js','fr',keys);
    assert.doesNotMatch(source,/DateTimeFormat/);
    assert.match(source,/\$f1Cache \$literal/);
    options.catalogs.en.a = '{n, number, percent}';
    options.catalogs.fr.a = '{n, number, percent}';
    options.catalogs.en.aaa = 'An earlier ID';options.catalogs.fr.aaa = 'Un ID antérieur';
    delete options.catalogs.en.date;delete options.catalogs.fr.date;
    const after = compileProject(options);
    assert.equal(compileSelection(after,'index.js','fr',keys),source);
    const {default:m} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    assert.equal(m.text({name:'Ada'}),'"$f0" \\ $f1Cache $literal </script>\u2028 Ada');
    assert.equal(m.money({n:3}),'FR '+new Intl.NumberFormat('fr',{style:'currency',currency:'EUR'}).format(3));
    assert.equal(m.plural({n:2}),'2 things');
    assert.equal(m.then(),'Then');assert.equal(m.default(),'Default');
    assert.deepEqual(Object.keys(m),['text','money','plural','then','default','__proto__','constructor']);
    assert.equal(Object.getPrototypeOf(m),null);
    assert.equal(m.__proto__({name:'Ada'}),'Prototype Ada');
    assert.equal(m.constructor({name:'Ada'}),'Constructor Ada');
    const emptySource=compileSelection(after,'index.js','en',[]);
    const empty=(await import(`data:text/javascript;base64,${Buffer.from(emptySource).toString('base64')}`)).default;
    assert.equal(Object.getPrototypeOf(empty),null);assert.deepEqual(Object.keys(empty),[]);
    const plain = compileSelection(after,'index.js','en',['then']);
    assert.doesNotMatch(plain,/Intl\.|\$f\d/);
    assert.match(plain,/const \$literal=/);
  }
});
