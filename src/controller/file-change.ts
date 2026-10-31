/**
 * Directive that forwards a file input's `change` event to a scope function.
 * Usage: `<input type="file" nfsu-file-change="loadFile">`.
 */
export function nfsuFileChange(): angular.IDirective {
  return {
    restrict: 'A',
    link(scope: angular.IScope, element: angular.IAugmentedJQuery, attrs: angular.IAttributes) {
      element.on('change', (event: Event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files && input.files[0];
        scope.$apply(() => {
          const name = attrs['nfsuFileChange'] as string;
          const handler = (scope as unknown as Record<string, (file: File | null) => void>)[name];
          handler(file ?? null);
        });
      });
    },
  };
}
