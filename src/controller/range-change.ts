/** Native input events only: changing the bounds or rendering a loaded value must not create a draft. */
export function nfsuRangeChange(): angular.IDirective {
  return {
    restrict: 'A',
    link(scope: angular.IScope, element: angular.IAugmentedJQuery, attrs: angular.IAttributes) {
      const input = element[0] as HTMLInputElement;
      const change = () => scope.$evalAsync(() => scope.$eval(attrs['nfsuRangeChange'], { $value: Number(input.value) }));
      element.on('input', change);
      scope.$on('$destroy', () => element.off('input', change));
    },
  };
}
