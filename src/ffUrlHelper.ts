import * as path from 'path';
import * as url from 'url';

export interface IURLHelper {
	convertToLocal(url_string: string): string;
	convertToWeb(path_string: string): string;
}

export class LocalURLHelper implements IURLHelper {
	public constructor() {}

	public convertToLocal(url_string: string): string {
		if (url_string.indexOf('file:///') !== 0) {
			return url_string;
		}
		return url_string.substring('file://'.length);
	}

	public convertToWeb(path_string: string): string {
		return 'file://' + path_string;
	}
}

export class HttpURLHelper implements IURLHelper {
	public constructor(public webRoot: string, public baseUrl: string) {}

	public convertToLocal(url_string: string): string {
		var parsed = url.parse(url_string);
		var pathname = parsed.pathname;
		return path.join(this.webRoot, pathname.substring(1));
	}

	public convertToWeb(path_string: string): string {
		var relative = path.relative(this.webRoot, path_string);
		var parts = relative.split('/');
		while (parts[0] === '.' || parts[0] === '..') parts.shift();
		return url.resolve(this.baseUrl, '/' + parts.join('/'));
	}
}
