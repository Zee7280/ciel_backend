import { BadRequestException } from '@nestjs/common';
import { TutorialsService } from './tutorials.service';

describe('TutorialsService URL validation', () => {
  const prefix = 'https://bucket.s3.eu.amazonaws.com/';
  const s3: any = {
    keyFromPublicUrl: (u: string) =>
      u.startsWith(prefix) ? decodeURIComponent(u.slice(prefix.length)) : null,
  };
  const service = new TutorialsService({} as any, s3);

  it('accepts storage-hosted https URLs', () => {
    expect(
      service.assertTutorialUrl(`${prefix}platform-tutorials/videos/a.mp4`, 'videoUrl'),
    ).toContain('platform-tutorials');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,AAAA',
    'http://bucket.s3.eu.amazonaws.com/platform-tutorials/a.mp4',
    'https://evil.example.com/a.mp4',
    `${prefix}other-folder/a.mp4`,
  ])('rejects %s', (url) => {
    expect(() => service.assertTutorialUrl(url, 'videoUrl')).toThrow(BadRequestException);
  });

  it('treats empty as null', () => {
    expect(service.assertTutorialUrl('', 'posterUrl')).toBeNull();
  });
});
