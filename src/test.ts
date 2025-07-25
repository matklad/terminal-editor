import * as path from 'path';
import * as Mocha from 'mocha';

export function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname, '.');

	return new Promise(async (c, e) => {
		try {
			const files = ['extension.test.js'];
			files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

			mocha.run(failures => {
				if (failures > 0) {
					e(new Error(`${failures} tests failed.`));
				} else {
					c();
				}
			});
		} catch (err) {
			console.error(err);
			e(err);
		}
	});
}